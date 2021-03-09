const configuration = {
    iceServers: [
        {urls: 'stun:stun.l.google.com:19302'}
    ]
};

const db = firebase.firestore();

const roomRef = db.collection('rooms').doc('fixedScaleableRoom');
const connectionsRef = roomRef.collection('connections');

let createdRoom = false;

let localUid = Math.random().toString(36).slice(-8);

const peerConnections = {};
const dataChannels = {};

const hangUpBtn = document.querySelector('#hang-up');
const msgContainer = document.querySelector('#messages-container');
const createRoomBtn = document.querySelector('#create-room');
const joinRoomBtn = document.querySelector('#join-room');
const msgArea = document.querySelector('#message');
const sendBtn = document.querySelector('#send');

function init() {
    createRoomBtn.addEventListener('click', createRoom);
    joinRoomBtn.addEventListener('click', joinRoom);
    hangUpBtn.addEventListener('click', hangUp);
    sendBtn.addEventListener('click', sendMsg);
    msgArea.addEventListener('keypress', event => {
        // Send a message if the send button is enabled and Ctrl->Enter has been pressed
        if(!sendBtn.disabled && event.code === 'Enter' && event.ctrlKey) {
            sendMsg();
        }
    });
}

async function createRoom() {
    // Create room doc w/ local uid and created time
    const roomData = {
        participants: [localUid],
        created: firebase.firestore.FieldValue.serverTimestamp()
    };

    const res = await roomRef.set(roomData);
    console.log(`Created room. id: ${roomRef.id}`, res);

    createdRoom = true;

    listenForIncomingOffers();

    // Update the UI (Creating answers to incoming offers already updates the UI,
    // but having an update here provides better feedback to the user)
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;
}

async function joinRoom() {
    const doc = await roomRef.get();

    if(!doc.exists) {
        console.warn('No room found.');
        return;
    }

    // Retrieve the room data
    const roomData = doc.data();
    console.log(doc.id, '=>', roomData);

    // Check for uid overlap (This should rarely need to be called if ever)
    while(roomData.participants.includes(localUid)) {
        localUid = Math.random().toString(36).slice(-8);
        console.warn(`Uid conflict. New uid created: ${localUid}`);
    }

    // Update the room document
    const updateData = {
        participants: firebase.firestore.FieldValue.arrayUnion(localUid)
    };

    const res = await roomRef.update(updateData);
    console.log('Updated room.', res);

    roomData.participants.forEach(participant => createOffer(participant));

    listenForIncomingOffers();
}

async function createOffer(participant) {
    // Create a connection
    const peerConnection = new RTCPeerConnection(configuration);
    peerConnections[participant] = peerConnection; // Map the connection to the participant

    registerPeerConnectionListeners(participant, peerConnection);

    // Create a data channel on the connection
    // (A channel or stream must be present for ICE candidate events to fire)
    const dataChannel = peerConnection.createDataChannel('messages');
    dataChannels[participant] = dataChannel; // Map the data channel to the participant

    registerDataChannelListeners(participant, dataChannel);

    const connectionDocRef = connectionsRef.doc(); // Create connection doc ref

    // Start collecting ICE candidates
    await collectIceCandidates(connectionDocRef, participant, peerConnection);

    // Create an offer and use it to set the Local Description
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log(participant, 'Created offer', offer);

    const connectionData = {
        from: localUid,
        to: participant,
        offer: {
            type: offer.type,
            sdp: offer.sdp
        }
    };

    // Send the offer to the signaling channel
    const res = await connectionDocRef.set(connectionData);
    console.log(participant, `Created connection doc with offer. id: ${connectionDocRef.id}`, res);

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;

    // Listen for an answer and use it to set the Remote Description
    const unsub = connectionDocRef.onSnapshot(async snapshot => {
        const data = snapshot.data();

        if(!peerConnection.currentRemoteDescription && data && data.answer) {
            const remoteDesc = new RTCSessionDescription(data.answer);
            await peerConnection.setRemoteDescription(remoteDesc);
            unsub();
        }
    }, error => {
        console.log(participant, 'Error listening for connection doc with answer', error);
    });
}

async function createAnswer(participant, connectionDoc) {
    // Create a connection
    const peerConnection = new RTCPeerConnection(configuration);
    peerConnections[participant] = peerConnection; // Map the connection to the participant
    
    registerPeerConnectionListeners(participant, peerConnection);

    // Listen for data channels
    peerConnection.addEventListener('datachannel', event => {
        const dataChannel = event.channel;
        dataChannels[participant] = dataChannel; // Map the data channel to the participant

        registerDataChannelListeners(participant, dataChannel);
    });

    // Start collecting ICE candidates
    await collectIceCandidates(connectionDoc.ref, participant, peerConnection);

    const connectionData = connectionDoc.data();

    // Use the offer to create the Remote Description
    const remoteDesc = new RTCSessionDescription(connectionData.offer);
    await peerConnection.setRemoteDescription(remoteDesc);

    // Create an answer and use it to set the Local Description
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    const answerData = {
        answer: {
            type: answer.type,
            sdp: answer.sdp
        }
    };

    // Send the answer to the signaling channel
    const res = await connectionDoc.ref.update(answerData);
    console.log(participant, `Updated connection doc with answer. id: ${connectionDoc.ref.id}`, res);

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;
}

function listenForIncomingOffers() {
    //// TODO: Map listener's unsub to object and call when unneeded?(w/ 30s min delay/lifetime for FS perf)
    const unsub = connectionsRef.onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const doc = change.doc;
            const connectionData = doc.data();

            if(change.type === 'added' && connectionData.to === localUid) {
                console.log(doc.id, '=>', connectionData);
                createAnswer(connectionData.from, doc)
            }
        });
    }, error => {
        console.error('Error listening to connections collection.\n', error);
    });
}

async function hangUp() {
    if(Object.keys(peerConnections).length > 0 || createdRoom) {
        cleanUpDb();

        if(createdRoom) createdRoom = false;
    }

    for(const participant in dataChannels) {
        const dataChannel = dataChannels[participant];
        dataChannel.close();

        delete dataChannels[participant]; // Remove the data channel from the global variable
    }

    for(const participant in peerConnections) {
        const peerConnection = peerConnections[participant];
        peerConnection.close();

        delete peerConnections[participant]; // Remove the peer connection from the global variable
    }

    // Update the UI
    createRoomBtn.disabled = false;
    joinRoomBtn.disabled = false;
    hangUpBtn.disabled = true;
    sendBtn.disabled = true;
}

async function cleanUpDb() {
    // Retrieve connections authored by this uid
    const authoredConnections = await connectionsRef.where('from', '==', localUid).get();

    authoredConnections.forEach(async connection => {
        const remoteUid = connection.data().to; // Retrieve the participant's uid

        const localCandidates = await connection.ref.collection(localUid).get();
        const remoteCandidates = await connection.ref.collection(remoteUid).get();

        const batch = db.batch();

        // Delete each connection's candidate docs
        localCandidates.forEach(candidate => batch.delete(candidate.ref));
        remoteCandidates.forEach(candidate => batch.delete(candidate.ref));

        batch.delete(connection.ref); // Delete the connection doc

        await batch.commit();
    });

    const roomDoc = await roomRef.get();

    if(roomDoc.exists) {
        const participants = roomDoc.data().participants;

        // If there are more than 2 participants left, remove localUid from room doc
        // Otherwise, delete the room doc
        if(participants.length > 2) {
            const updateData = {
                participants: firebase.firestore.FieldValue.arrayRemove(localUid)
            };
        
            const res = await roomRef.update(updateData);
            console.log('Deleted uid from room.', res);
        }else{
            const res = await roomRef.delete();
            console.log('Deleted room.', res);
        }
    }
}

async function collectIceCandidates(connectionDocRef, participant, peerConnection) {
    const localCandidatesColl = connectionDocRef.collection(localUid);
    const remoteCandidatesColl = connectionDocRef.collection(participant);

    peerConnection.addEventListener('icecandidate', event => {
        if(event.candidate) {
            console.log(participant, 'Got candidate', event.candidate);

            // Send candidate to signaling channel
            localCandidatesColl.add(event.candidate.toJSON());
        }
    });

    //// TODO: Map listener's unsub to object and call when unneeded?(w/ 30s min delay/lifetime for FS perf)
    // Listen to signaling channel for remote candidates
    remoteCandidatesColl.onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if(change.type === 'added') {
                const data = change.doc.data();
                console.log(participant, 'Got remote candidate', data);

                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(data));
                } catch (error) {
                    console.error('Error adding remote ICE candidate', error);
                }
            }
        });
    });
}

function registerPeerConnectionListeners(participant, peerConnection) {
    peerConnection.addEventListener('icegatheringstatechange', event => {
        console.log(participant, `ICE gathering state change: ${peerConnection.iceGatheringState}`);
    });

    peerConnection.addEventListener('connectionstatechange', event => {
        console.log(participant, `Connection state change: ${peerConnection.connectionState}`);
    });

    peerConnection.addEventListener('signalingstatechange', event => {
        console.log(participant, `Signaling state change: ${peerConnection.signalingState}`);
    });

    peerConnection.addEventListener('iceconnectionstatechange', event => {
        console.log(participant, `ICE connection state change: ${peerConnection.iceConnectionState}`);
    });
}

function registerDataChannelListeners(participant, dataChannel) {
    dataChannel.addEventListener('open', event => {
        console.log(participant, 'Data channel open');

        createRoomBtn.disabled = true;
        joinRoomBtn.disabled = true;
        hangUpBtn.disabled = false;
        sendBtn.disabled = false;
    });

    dataChannel.addEventListener('close', event => {
        console.log(participant, 'Data channel close');

        delete dataChannels[participant]; // Remove the data channel from the global variable

        // Hang up if all data channels have closed
        if(Object.keys(dataChannels).length === 0) hangUp();
    });

    dataChannel.addEventListener('message', event => {
        console.log(participant, 'Message received: ', event.data);

        // Add message to container
        const el = document.createElement('p');
        el.innerText = `${participant}: ${event.data}`;
        el.className = 'other';

        msgContainer.appendChild(el);

        el.scrollIntoView(); // Scroll to the newly added element
    });
}

function sendMsg() {
    if(msgArea.value) {
        // Add message to container
        const el = document.createElement('p');
        el.innerText = `me: ${msgArea.value}`;
        el.className = 'self';

        msgContainer.appendChild(el);

        // Send msg from data channel
        for(const participant in dataChannels) {
            const dataChannel = dataChannels[participant];
            dataChannel.send(msgArea.value);
        }

        el.scrollIntoView(); // Scroll to the newly added element

        msgArea.value = ''; // Clear the message text area
    }
}

init();