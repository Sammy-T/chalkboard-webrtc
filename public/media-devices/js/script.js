const localVideo = document.querySelector('#local-video');
const playButton = document.querySelector('#play-button');
const videoSelect = document.querySelector('#video-select');
const audioSelect = document.querySelector('#audio-select');
const mediaSelection = document.querySelector('#media-selection');
const videoTypeRadios = document.querySelectorAll('.video-type');

let videoType = 'camera';

let constraints = {'video': true, 'audio': true};

queryDevices();

playButton.addEventListener('click', (event) => {
    const buttonText = playButton.textContent;

    switch(buttonText) {
        case "Start":
            if(videoType === 'camera'){
                startCameraStream();
            }else if(videoType === 'screen-share'){
                startDisplayStream();
            }
            break;

        case "Stop":
            stopCameraStream();
            break;

        default:
            console.error('Invalid button text', buttonText);
    }
});

videoSelect.addEventListener('change', function(event) {
    switch(this.value) {
        case 'auto':
            constraints.video = true;
            break;

        case 'off':
            constraints.video = false;
            break;

        default:
            constraints.video = {'deviceId': this.value};
    }

    console.log(`Selected ${this.value}`, constraints);
});

audioSelect.addEventListener('change', function(event) {
    switch(this.value) {
        case 'auto':
            constraints.audio = true;
            break;

        case 'off':
            constraints.audio = false;
            break;

        default:
            constraints.audio = {'deviceId': this.value};
    }

    console.log(`Selected ${this.value}`, constraints);
});

videoTypeRadios.forEach(radioInput => {
    radioInput.addEventListener('change', radioChecked);
});

function radioChecked(event) {
    const videoSelectField = document.querySelector('#video-field');

    switch(event.target.value) {
        case 'camera':
            videoSelectField.style.display = '';
            videoType = event.target.value;
            break;

        case 'screen-share':
            videoSelectField.style.display = 'none';
            videoType = event.target.value;
            break;

        default:
            console.error('Invalid radio selection', event.target.value);
    }
}

async function startCameraStream() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        localVideo.srcObject = stream; // Output the stream to the video element

        // Update the UI
        playButton.textContent = "Stop";
        mediaSelection.disabled = true;
    } catch (error) {
        console.error('Error streaming camera.', error);
    }
}

function stopCameraStream() {
    // Use the srcObject's stream to to get its track list
    const tracks = localVideo.srcObject.getTracks();

    // Stop each track
    tracks.forEach(track => {
        track.stop();
    });

    // Set srcObject to null to sever the link with the
    // MediaStream so it can be released.
    localVideo.srcObject = null;

    // Update the UI
    playButton.textContent = "Start";
    mediaSelection.disabled = false;
}

async function queryDevices() {
    // Query the available devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('Found devices:', devices);

    // Filter 'videoinput' and 'audioinput' devices into respective arrays
    const videoInputDevices = devices.filter(device => device.kind === 'videoinput');
    const audioInputDevices = devices.filter(device => device.kind === 'audioinput');

    console.log('Video input devices:', videoInputDevices);
    console.log('Audio input devices', audioInputDevices);

    // Clear any previous options
    videoSelect.innerHTML = '';
    audioSelect.innerHTML = '';

    // Add the default and off options
    const defaultOption = document.createElement('option');
    defaultOption.text = 'Auto';
    defaultOption.value = 'auto';

    const offOption = document.createElement('option');
    offOption.text = 'Off';
    offOption.value = 'off';

    videoSelect.appendChild(defaultOption.cloneNode(true));
    videoSelect.appendChild(offOption.cloneNode(true));
    audioSelect.appendChild(defaultOption.cloneNode(true));
    audioSelect.appendChild(offOption.cloneNode(true));

    // Display the device options in their corresponding select elements
    videoInputDevices.forEach(device => {
        if(device.label === '') return;

        const deviceOption = document.createElement('option');
        deviceOption.text = device.label;
        deviceOption.value = device.deviceId;

        videoSelect.appendChild(deviceOption);
    });

    audioInputDevices.forEach(device => {
        if(device.label === '') return;
        
        const deviceOption = document.createElement('option');
        deviceOption.text = device.label;
        deviceOption.value = device.deviceId;

        audioSelect.appendChild(deviceOption);
    });
}

// Listen for changes to media devices and update the device options
navigator.mediaDevices.addEventListener('devicechange', event => {
    queryDevices();
});

async function startDisplayStream() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({video: true, audio: true});

        localVideo.srcObject = stream; // Output the stream to the video element

        // Update the UI
        playButton.disabled = true;
        mediaSelection.disabled = true;

        // Listen for the end of the video track
        // to signal when we should re-enable the inputs
        stream.getVideoTracks()[0].addEventListener('ended', () => {
            playButton.disabled = false;
            mediaSelection.disabled = false;
        });
    } catch (error) {
        console.error('Error streaming display.', error);
    }
}