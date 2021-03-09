const configuration = {
    iceServers: [
        {urls: 'stun:stun.l.google.com:19302'}
    ]
};

let constraints = {'video': true, 'audio': true};

const callerName = 'caller';
const calleeName = 'callee';

const db = firebase.firestore();
const roomRef = db.collection('media-rooms').doc('fixedRoom');;

let peerConnection = null;
let localStream = null;
let remoteStream = null;

const hangUpBtn = document.querySelector('#hang-up');
const createRoomBtn = document.querySelector('#create-room');
const joinRoomBtn = document.querySelector('#join-room');
const localVideo = document.querySelector('#local-video');
const remoteVideo = document.querySelector('#remote-video');

function init() {
    createRoomBtn.addEventListener('click', createRoom);
    joinRoomBtn.addEventListener('click', joinRoom);
    hangUpBtn.addEventListener('click', hangUp);
}

async function createRoom() {
    await startVideoStream();

    peerConnection = new RTCPeerConnection(configuration);

    registerPeerConnectionListeners();

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Start collecting ICE candidates
    await collectIceCandidates(callerName, calleeName);

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
    await startVideoStream();

    const snapshot = await roomRef.get();

    if(!snapshot.exists) {
        console.warn(`Matching room not found for ${roomRef.id}`);
        return;
    }

    peerConnection = new RTCPeerConnection(configuration);

    registerPeerConnectionListeners();

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Start collecting ICE candidates
    await collectIceCandidates(calleeName, callerName);

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
    stopVideoStream();

    if(peerConnection) {
        peerConnection.close();
    }

    // Clean up db
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

    // Update the UI
    createRoomBtn.disabled = false;
    joinRoomBtn.disabled = false;
    hangUpBtn.disabled = true;
}

async function collectIceCandidates(localName, remoteName) {
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
    peerConnection.addEventListener('track', event => {
        console.log('Got remote track', event.streams[0]);

        event.streams[0].getTracks().forEach(track => {
            console.log('Adding track to remote stream', track);
            remoteStream.addTrack(track);
        });
    });

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

async function startVideoStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        remoteStream = new MediaStream();


        // Output the streams to the video elements
        localVideo.srcObject = localStream;
        remoteVideo.srcObject = remoteStream;
    } catch (error) {
        console.error('Error starting video streams', error);
    }
}

function stopVideoStream() {
    if(localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    if(remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
    }

    // Set srcObject to null to sever the link with the MediaStreams
    // so they can be released
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
}

init();