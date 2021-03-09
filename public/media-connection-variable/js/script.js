const configuration = {
    iceServers: [
        {urls: 'stun:stun.l.google.com:19302'}
    ]
};

let constraints = {video: false, audio: true};

const callerName = 'caller';
const calleeName = 'callee';

const db = firebase.firestore();
const roomRef = db.collection('media-rooms').doc('fixedRoom');
let unsub = null;

let role = null;
let offerTimestamp = null;

let peerConnection = null;
let localStream = null;
let remoteStream = null;

const hangUpBtn = document.querySelector('#hang-up');
const createRoomBtn = document.querySelector('#create-room');
const joinRoomBtn = document.querySelector('#join-room');
const toggleVideoBtn = document.querySelector('#toggle-video');
const localVideo = document.querySelector('#local-video');
const remoteVideo = document.querySelector('#remote-video');

function init() {
    createRoomBtn.addEventListener('click', () => {
        role = callerName;
        joinRoom();
    });

    joinRoomBtn.addEventListener('click', () => {
        role = calleeName;
        joinRoom();
    });

    hangUpBtn.addEventListener('click', hangUp);
    toggleVideoBtn.addEventListener('click', toggleVideo);
}

async function createRoom() {
    role = callerName;

    await startStream();

    peerConnection = new RTCPeerConnection(configuration);

    registerPeerConnectionListeners();

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Start collecting ICE candidates
    await collectIceCandidates(callerName, calleeName);

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;

    addNegotiater();
}

async function joinRoom() {
    await startStream();

    peerConnection = new RTCPeerConnection(configuration);

    registerPeerConnectionListeners();

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Start collecting ICE candidates
    await collectIceCandidates(calleeName, callerName);

    addNegotiater();

    // Update the UI
    createRoomBtn.disabled = true;
    joinRoomBtn.disabled = true;
    hangUpBtn.disabled = false;
}

function addNegotiater() {
    unsub = roomRef.onSnapshot(async snapshot => {
        const data = snapshot.data();

        if(data) {
            if(data.from && data.from == role && data.answer) {
                console.log('Receieved new answer: ', data.answer, data);
    
                const remoteDesc = new RTCSessionDescription(data.answer);
                await peerConnection.setRemoteDescription(remoteDesc);
            }else if(data.from && data.from != role && data.offer && (!offerTimestamp || offerTimestamp.getTime() != data.offerTime.toDate().getTime())) {
                console.log('Received new offer: ', data.offer, data);

                offerTimestamp = data.offerTime.toDate();

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
            }
        }
    }, error => {
        console.log('Error listening for room with answer', error);
    });
}

async function hangUp() {
    stopStream();

    if(peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if(unsub) {
        unsub();
        unsub = null;
    }

    role = null;

    constraints = {'video': false, 'audio': true};

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

    peerConnection.addEventListener('negotiationneeded', async event => {
        console.log(`Negotiation needed`);

        // Create a new offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        offerTimestamp = new Date();

        const offerData = {
            from: role,
            offer: {
                type: offer.type,
                sdp: offer.sdp
            },
            offerTime: firebase.firestore.Timestamp.fromDate(offerTimestamp),
            answer: null
        };

        // Update the signalling channel with the offer
        const res = await roomRef.set(offerData, {merge: true});
        console.log(`Updated room. id: ${roomRef.id}`, res);
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

async function startStream() {
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

function stopStream() {
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

    localStream = null;
    remoteStream = null;
}

function toggleVideo() {
    if(!localStream) {
        return;
    }else if(localStream.getVideoTracks().length === 0) {
        upgradeCall();
        return;
    }

    localStream.getTracks().forEach(track => {
        if(track.kind === 'video') {
            track.enabled = !track.enabled;
        }
    });
}

async function upgradeCall() {
    try {
        console.log('Upgrading call');

        // Update the constraints
        // (This isn't necessary at this point but I'd like it match the state)
        constraints.video = true;

        // Retrieve the video & tracks
        const stream = await navigator.mediaDevices.getUserMedia({video: true});
        const videoTracks = stream.getVideoTracks();

        localVideo.srcObject = null;

        // Add the video tracks to the local stream and peer connection
        videoTracks.forEach(track => {
            localStream.addTrack(track);
            peerConnection.addTrack(track, localStream);
        });

        localVideo.srcObject = localStream;
    } catch (error) {
        console.error('Error upgrading call.', error);
    }
}

init();