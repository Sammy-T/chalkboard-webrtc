const configuration = {
    iceServers: [
        {urls: 'stun:stun.l.google.com:19302'}
    ]
};

const callerName = 'caller';
const calleeName = 'callee';

const db = firebase.firestore();

let peerConnection = null;
let dataChannel = null;

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
    const roomRef = db.collection('rooms').doc('fixedRoom');

    peerConnection = new RTCPeerConnection(configuration);

    registerPeerConnectionListeners();

    // Create a data channel on the connection
    // (A channel or stream must be present for ICE candidate events to fire)
    dataChannel = peerConnection.createDataChannel('channel-name');

    registerDataChannelListeners();

    // Start collecting ICE candidates
    await collectIceCandidates(roomRef, callerName, calleeName);

    // Create an offer and use it to set the Local Description
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log('Created offer', offer);

    const offerData = {
        offer: {
            type: offer.type,
            sdp: offer.sdp
        }
    };

    // Send the offer to the signaling channel
    const res = await roomRef.set(offerData);
    console.log(`Created room with offer. id: ${roomRef.id}`, res);

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;

    // Listen for an answer and use it to set the Remote Description
    const unsub = roomRef.onSnapshot(async snapshot => {
        const data = snapshot.data();

        if(!peerConnection.currentRemoteDescription && data && data.answer) {
            const remoteDesc = new RTCSessionDescription(data.answer);
            await peerConnection.setRemoteDescription(remoteDesc);
            unsub();
        }
    }, error => {
        console.log('Error listening for room with answer', error);
    });
}

async function joinRoom() {
    const roomRef = db.collection('rooms').doc('fixedRoom');
    const snapshot = await roomRef.get();

    if(!snapshot.exists) {
        console.warn(`Matching room not found for ${roomRef.id}`);
        return;
    }

    peerConnection = new RTCPeerConnection(configuration);

    registerPeerConnectionListeners();

    // Listen for data channels
    peerConnection.addEventListener('datachannel', event => {
        dataChannel = event.channel;

        registerDataChannelListeners();
    });

    // Start collecting ICE candidates
    await collectIceCandidates(roomRef, calleeName, callerName);

    const data = snapshot.data();

    // Use the offer to create the Remote Description
    const remoteDesc = new RTCSessionDescription(data.offer);
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
    const res = await roomRef.update(answerData);
    console.log(`Updated room with answer. id: ${roomRef.id}`, res);

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;
}

async function hangUp() {
    if(dataChannel) {
        dataChannel.close();
    }

    if(peerConnection) {
        peerConnection.close();
    }

    // Clean up db
    const roomRef = db.collection('rooms').doc('fixedRoom');
    const callerCandidates = await roomRef.collection(callerName).get();
    const calleeCandidates = await roomRef.collection(calleeName).get();

    const batch = db.batch();

    callerCandidates.forEach(candidate => {
        batch.delete(candidate.ref);
    });

    calleeCandidates.forEach(candidate => {
        batch.delete(candidate.ref);
    });

    batch.delete(roomRef);

    await batch.commit();
}

async function collectIceCandidates(roomRef, localName, remoteName) {
    const localCandidatesColl = roomRef.collection(localName);
    const remoteCandidatesColl = roomRef.collection(remoteName);

    peerConnection.addEventListener('icecandidate', event => {
        if(event.candidate) {
            console.log('Got candidate', event.candidate);

            // Send candidate to signaling channel
            localCandidatesColl.add(event.candidate.toJSON());
        }
    });

    // Listen to signaling channel for remote candidates
    remoteCandidatesColl.onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if(change.type === 'added') {
                const data = change.doc.data();
                console.log('Got remote candidate', data);

                try {
                    await peerConnection.addIceCandidate(new RTCIceCandidate(data));
                } catch (error) {
                    console.error('Error adding remote ICE candidate', error);
                }
            }
        });
    });
}

function registerPeerConnectionListeners() {
    peerConnection.addEventListener('icegatheringstatechange', event => {
        console.log(`ICE gathering state change: ${peerConnection.iceGatheringState}`);
    });

    peerConnection.addEventListener('connectionstatechange', event => {
        console.log(`Connection state change: ${peerConnection.connectionState}`);
    });

    peerConnection.addEventListener('signalingstatechange', event => {
        console.log(`Signaling state change: ${peerConnection.signalingState}`);
    });

    peerConnection.addEventListener('iceconnectionstatechange', event => {
        console.log(`ICE connection state change: ${peerConnection.iceConnectionState}`);
    });
}

function registerDataChannelListeners() {
    dataChannel.addEventListener('open', event => {
        console.log('Data channel open');

        createRoomBtn.disabled = true;
        joinRoomBtn.disabled = true;
        hangUpBtn.disabled = false;
        sendBtn.disabled = false;
    });

    dataChannel.addEventListener('close', event => {
        console.log('Data channel close');
        createRoomBtn.disabled = false;
        joinRoomBtn.disabled = false;
        hangUpBtn.disabled = true;
        sendBtn.disabled = true;
    });

    dataChannel.addEventListener('message', event => {
        console.log('Message received: ', event.data);

        // Add message to container
        const el = document.createElement('p');
        el.innerText = `other: ${event.data}`;
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
        dataChannel.send(msgArea.value);

        el.scrollIntoView(); // Scroll to the newly added element

        msgArea.value = ''; // Clear the message text area
    }
}

init();