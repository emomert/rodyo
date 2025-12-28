import { Peer } from 'peerjs';

// DOM Elements
const onboardingUi = document.getElementById('onboarding-ui');
const dashboardUi = document.getElementById('dashboard-ui');
const broadcasterUi = document.getElementById('broadcaster-ui');
const listenerUi = document.getElementById('listener-ui');

const btnStartSetup = document.getElementById('btn-start-setup');
const btnEditSettings = document.getElementById('btn-edit-settings');
const btnStartBroadcast = document.getElementById('btn-start-broadcast');
const btnStopBroadcast = document.getElementById('btn-stop-broadcast');
const btnTuneIn = document.getElementById('btn-tune-in');
const onAirLamp = document.getElementById('on-air-lamp');

const broadcasterCanvas = document.getElementById('broadcaster-canvas');
const listenerCanvas = document.getElementById('listener-canvas');

const statusTag = document.getElementById('status-tag');
const stationIdDisplay = document.getElementById('station-id-display');
const listenerCountDisplay = document.getElementById('listener-count');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSendChat = document.getElementById('btn-send-chat');
const listenerRole = document.getElementById('listener-role');
const parentNodeIdDisplay = document.getElementById('parent-node-id');
const totalListenerCountDisplay = document.getElementById('total-listener-count');
const peerListContainer = document.getElementById('peer-list');
const listenerMgmt = document.getElementById('listener-mgmt');
const remoteAudio = document.getElementById('remote-audio');

// Settings Elements
const settingHandle = document.getElementById('setting-handle');
const settingName = document.getElementById('setting-name');
const settingGenre = document.getElementById('setting-genre');
const settingTheme = document.getElementById('setting-theme');
const headerTagline = document.getElementById('station-tagline');

// Mesh Configuration
const MAX_CHILDREN = 2;
let peer = null;
let localStream = null;
let currentRemoteStream = null;
let parentConn = null; // Connection to parent in mesh
let childConns = []; // Connections to children in mesh
let isBroadcaster = false;

// Web Audio State
let audioContext = null;
let analyser = null;
let animationId = null;

// Peer Registry (Broadcaster only)
let peerRegistry = {};

// Settings State
let stationConfig = {
    handle: '',
    name: 'RODYO STATION',
    genre: 'P2P MESH BROADCASTING // ANALOG SOUL',
    theme: 'matrix-green'
};

// Initialization
const urlParams = new URLSearchParams(window.location.search);
const targetStationId = urlParams.get('station');

if (targetStationId) {
    onboardingUi.style.display = 'none';
    dashboardUi.style.display = 'grid';
    showListenerUI();
} else {
    loadAndApplySettings();
    showBroadcasterUI();
}

function loadAndApplySettings() {
    const saved = localStorage.getItem('rodyo_config');
    if (saved) {
        stationConfig = JSON.parse(saved);
    }

    if (isBroadcaster) {
        settingHandle.value = stationConfig.handle;
        settingName.value = stationConfig.name === 'RODYO STATION' ? '' : stationConfig.name;
        settingGenre.value = stationConfig.genre.includes('P2P') ? '' : stationConfig.genre;
        settingTheme.value = stationConfig.theme;
    }

    applySettingsLocally();
}

function applySettingsLocally() {
    document.body.setAttribute('data-theme', stationConfig.theme);
    headerTagline.textContent = stationConfig.genre;
    document.title = `${stationConfig.name} // RODYO`;
}

btnStartSetup.addEventListener('click', () => {
    saveSettings();
    onboardingUi.style.display = 'none';
    dashboardUi.style.display = 'grid';
});

btnEditSettings.addEventListener('click', () => {
    onboardingUi.style.display = 'block';
    dashboardUi.style.display = 'none';
});

function saveSettings() {
    stationConfig.handle = settingHandle.value.trim().toLowerCase().replace(/\s+/g, '-');
    stationConfig.name = settingName.value || 'RODYO STATION';
    stationConfig.genre = settingGenre.value || 'P2P MESH BROADCASTING // ANALOG SOUL';
    stationConfig.theme = settingTheme.value;

    localStorage.setItem('rodyo_config', JSON.stringify(stationConfig));
    applySettingsLocally();

    if (peer && isBroadcaster) {
        relayData({ type: 'STATION_UPDATE', config: stationConfig }, null);
    }

    // Hide listener management if not broadcaster
    if (listenerMgmt) {
        listenerMgmt.style.display = isBroadcaster ? 'block' : 'none';
    }

    addChatMessage('System', 'Station configuration updated.');
}

function showBroadcasterUI() {
    broadcasterUi.style.display = 'block';
    listenerUi.style.display = 'none';
    isBroadcaster = true;
}

function showListenerUI() {
    broadcasterUi.style.display = 'none';
    listenerUi.style.display = 'block';
    isBroadcaster = false;
    addChatMessage('System', `Searching for entry point to station: ${targetStationId}`);
}

// PeerJS Setup
function initPeer() {
    // If broadcaster has a handle, use it as the ID
    const customId = (isBroadcaster && stationConfig.handle) ? stationConfig.handle : null;

    // Production ICE Servers for NAT Traversal (Friends connecting over public internet)
    const peerConfig = {
        debug: 1,
        config: {
            'iceServers': [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
            ]
        }
    };

    peer = new Peer(customId, peerConfig);

    peer.on('open', (id) => {
        console.log('My peer ID is: ' + id);
        if (isBroadcaster) {
            stationIdDisplay.textContent = id;
            statusTag.textContent = '[LIVE]';
            statusTag.style.color = 'var(--accent-color)';

            const shareUrl = `${window.location.origin}${window.location.pathname}?station=${id}`;
            addChatMessage('System', `Broadcasting live! Share this link: ${shareUrl}`);

            // Broadcaster registers itself
            peerRegistry[id] = { childrenCount: 0, parentId: null };
        }
    });

    peer.on('connection', (conn) => {
        handleIncomingConnection(conn);
    });

    peer.on('call', (call) => {
        // If we have a stream (either local or from parent), answer the call
        const streamToShare = isBroadcaster ? localStream : currentRemoteStream;
        if (streamToShare) {
            call.answer(streamToShare);
        } else {
            console.warn('Call received but no stream available to share');
            call.answer(); // Still answer to keep connection open
        }
    });

    peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        addChatMessage('System', `Error: ${err.type}`);
    });
}

function handleIncomingConnection(conn) {
    conn.on('open', () => {
        if (isBroadcaster) {
            // Broadcaster acts as the orchestrator
            processNewListener(conn);
        } else {
            // Listener receives data from children (mostly chat)
            setupMeshConnection(conn, false);
        }
    });
}

function processNewListener(conn) {
    // Find a node in the mesh that has available slots
    const targetNodeId = findAvailableNode();

    if (targetNodeId === peer.id) {
        // Accept as direct child
        if (childConns.length < MAX_CHILDREN) {
            acceptChild(conn);
        } else {
            // Should not happen if findAvailableNode works correctly
            console.error('Broadcaster full but tried to accept child');
        }
    } else {
        // Redirect listener to the available node
        conn.send({ type: 'MESH_REDIRECT', targetId: targetNodeId });
        setTimeout(() => conn.close(), 1000); // Close connection after redirect
    }
}

function findAvailableNode() {
    // Simple Breadth-First Search to find node with < MAX_CHILDREN
    const queue = [peer.id];
    const visited = new Set();

    while (queue.length > 0) {
        const currentId = queue.shift();
        if (visited.has(currentId)) continue;
        visited.add(currentId);

        const info = peerRegistry[currentId];
        if (info && info.childrenCount < MAX_CHILDREN) {
            return currentId;
        }

        // Add children of current node to queue
        Object.keys(peerRegistry).forEach(id => {
            if (peerRegistry[id].parentId === currentId) {
                queue.push(id);
            }
        });
    }
    return peer.id; // Fallback
}

function acceptChild(conn) {
    childConns.push(conn);
    updateListenerCountDisplay();

    if (isBroadcaster) {
        peerRegistry[conn.peer] = { childrenCount: 0, parentId: peer.id };
        peerRegistry[peer.id].childrenCount++;

        // Send current station config to new listener
        setTimeout(() => {
            conn.send({ type: 'STATION_UPDATE', config: stationConfig });
        }, 500);
    } else {
        if (listenerRole) listenerRole.textContent = 'RELAY';
    }

    setupMeshConnection(conn, true);
    addChatMessage('System', `New listener connected: ${conn.peer.substring(0, 4)}`);

    if (isBroadcaster) {
        updateBroadcasterPeerList();
        broadcastMeshSummary();
    }
}

function setupMeshConnection(conn, isChild) {
    conn.on('data', (data) => {
        if (data.type === 'chat') {
            addChatMessage(data.user, data.msg);
            relayData(data, conn); // Relay to everyone except where it came from
        } else if (data.type === 'MESH_REDIRECT') {
            // Handle redirect as listener
            addChatMessage('System', `Redirecting to node: ${data.targetId.substring(0, 4)}`);
            parentConn.close();
            connectToNode(data.targetId);
        } else if (data.type === 'PEER_UPDATE') {
            // Broadcaster logic: Update registry when a peer reports its children
            if (isBroadcaster) {
                if (peerRegistry[data.peerId]) {
                    peerRegistry[data.peerId].childrenCount = data.count;
                }
            }
        } else if (data.type === 'STATION_UPDATE') {
            // Listener logic: Update visual theme and metadata
            stationConfig = data.config;
            applySettingsLocally();
        } else if (data.type === 'MOD_KICK') {
            addChatMessage('System', 'You have been removed from the station by the broadcaster.');
            setTimeout(() => location.reload(), 2000);
        } else if (data.type === 'MESH_REPORT') {
            if (isBroadcaster) {
                // Register or update peer in mesh
                if (!peerRegistry[data.peerId]) {
                    peerRegistry[data.peerId] = { children: [] };
                }
                peerRegistry[data.peerId].children = data.children;

                // Also ensure children are in registry if they aren't
                data.children.forEach(childId => {
                    if (!peerRegistry[childId]) peerRegistry[childId] = { children: [] };
                });

                updateBroadcasterPeerList();
                broadcastMeshSummary();
            } else {
                // Relay up to parent (towards source)
                if (parentConn && parentConn.open) parentConn.send(data);
            }
        }
    });

    conn.on('close', () => {
        if (isChild) {
            childConns = childConns.filter(c => c !== conn);
            if (isBroadcaster) {
                delete peerRegistry[conn.peer];
                peerRegistry[peer.id].childrenCount--;
                updateBroadcasterPeerList();
                broadcastMeshSummary();
            } else {
                // Report back to parent that a child left
                reportToParent();
            }
        } else {
            parentConn = null;
            addChatMessage('System', 'Disconnected from relay node.');
        }
        updateListenerCountDisplay();
    });
}

function reportToParent() {
    if (parentConn && parentConn.open) {
        parentConn.send({
            type: 'MESH_REPORT',
            peerId: peer.id,
            children: childConns.map(c => c.peer)
        });
    }
}

function broadcastMeshSummary() {
    if (!isBroadcaster) return;
    // Walk the registry to count unique listeners
    const total = Object.keys(peerRegistry).length - 1;
    if (totalListenerCountDisplay) {
        totalListenerCountDisplay.textContent = total;
    }
}

function updateBroadcasterPeerList() {
    if (!peerListContainer) return;
    peerListContainer.innerHTML = '';

    // Sort so direct children are first
    const peers = Object.keys(peerRegistry)
        .filter(id => id !== peer.id)
        .sort((a, b) => {
            const aDirect = childConns.some(c => c.peer === a);
            const bDirect = childConns.some(c => c.peer === b);
            return (aDirect === bDirect) ? 0 : aDirect ? -1 : 1;
        });
    if (peers.length === 0) {
        peerListContainer.innerHTML = '<p style="opacity: 0.5;">No active listeners.</p>';
        return;
    }

    peers.forEach(id => {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.alignItems = 'center';
        div.style.padding = '2px 0';

        const isDirect = childConns.some(c => c.peer === id);

        div.innerHTML = `
            <span>${id.substring(0, 8)}... ${isDirect ? '[DIRECT]' : '[MESH]'}</span>
            ${isDirect ? `<button onclick="kickPeer('${id}')" style="font-size: 0.6rem; padding: 2px 5px; background: rgba(255,0,0,0.2); color: #ff5555; border: 1px solid #ff5555; cursor: pointer;">KICK</button>` : ''}
        `;
        peerListContainer.appendChild(div);
    });
}

window.kickPeer = function (peerId) {
    const conn = childConns.find(c => c.peer === peerId);
    if (conn) {
        conn.send({ type: 'MOD_KICK' });
        setTimeout(() => conn.close(), 500);
        addChatMessage('System', `Kicked listener: ${peerId}`);
    }
};
// Broadcasting Logic
btnStartBroadcast.addEventListener('click', async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        initPeer();

        // Start Visualizer
        startVisualizer(localStream, broadcasterCanvas);
        if (onAirLamp) onAirLamp.style.display = 'block';

        btnStartBroadcast.style.display = 'none';
        btnStopBroadcast.style.display = 'inline-block';

        addChatMessage('System', 'Broadcaster initialized. Microphone captured.');
    } catch (err) {
        console.error('Failed to get local stream', err);
        addChatMessage('System', 'Error: Could not access microphone.');
    }
});

btnStopBroadcast.addEventListener('click', () => {
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    if (peer) peer.destroy();
    location.reload(); // Hard reset for simplicity
});

// Listener Logic
btnTuneIn.addEventListener('click', () => {
    if (!targetStationId) return;

    // "Prime" the audio element to unlock it for mobile autoplay
    if (remoteAudio) {
        remoteAudio.play().catch(() => { /* Silent failure is expected here */ });
    }

    initPeer();
    peer.on('open', () => {
        connectToNode(targetStationId);
    });
});

function connectToNode(nodeId) {
    const conn = peer.connect(nodeId);
    parentConn = conn;

    if (parentNodeIdDisplay) {
        parentNodeIdDisplay.textContent = nodeId.substring(0, 8) + '...';
    }

    conn.on('open', () => {
        addChatMessage('System', `Established protocol connection with ${nodeId === targetStationId ? 'Broadcaster' : 'Relay Node'}`);

        // Initiate audio call
        const call = peer.call(nodeId, new MediaStream());
        call.on('stream', (remoteStream) => {
            handleRemoteStream(remoteStream);
        });
        setupMeshConnection(conn, false);
    });
}

function handleRemoteStream(stream) {
    currentRemoteStream = stream;
    if (remoteAudio) {
        remoteAudio.srcObject = stream;
        remoteAudio.play().catch(err => {
            console.error('Audio playback failed:', err);
            addChatMessage('System', '⚠️ Audio blocked by browser. Please tap the screen to enable sound.');

            const unlock = () => {
                remoteAudio.play();
                document.removeEventListener('click', unlock);
            };
            document.addEventListener('click', unlock);
        });

        startVisualizer(stream, listenerCanvas);
    }
    addChatMessage('System', 'Streaming audio started.');
}

function startVisualizer(stream, canvas) {
    if (!canvas) return;

    if (audioContext) audioContext.close();
    if (animationId) cancelAnimationFrame(animationId);

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const ctx = canvas.getContext('2d');

    const resize = () => {
        if (!canvas.clientWidth) return;
        canvas.width = canvas.clientWidth * window.devicePixelRatio;
        canvas.height = canvas.clientHeight * window.devicePixelRatio;
    };
    window.addEventListener('resize', resize);
    resize();

    function draw() {
        animationId = requestAnimationFrame(draw);
        analyser.getByteTimeDomainData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const color = getComputedStyle(document.body).getPropertyValue('--accent-color').trim();

        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.beginPath();

        const sliceWidth = canvas.width / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = (v * canvas.height) / 2;

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);

            x += sliceWidth;
        }

        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
    }

    draw();
}

// Chat & Data Relay
function relayData(data, sourceConn) {
    if (parentConn && parentConn !== sourceConn && parentConn.open) {
        parentConn.send(data);
    }
    childConns.forEach(conn => {
        if (conn !== sourceConn && conn.open) {
            conn.send(data);
        }
    });
}

btnSendChat.addEventListener('click', sendChat);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChat();
});

function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg) return;

    const chatData = {
        type: 'chat',
        user: isBroadcaster ? 'Broadcaster' : 'Listener-' + peer.id.substring(0, 4),
        msg: msg
    };

    addChatMessage('You', msg);
    relayData(chatData, null);
    chatInput.value = '';
}

function updateListenerCountDisplay() {
    listenerCountDisplay.textContent = childConns.length;
}

function addChatMessage(user, msg) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.classList.add('msg');
    if (user === 'System') div.classList.add('system');
    div.innerHTML = `<span style="opacity: 0.5; font-size: 0.7rem;">[${time}]</span> <strong>${user}:</strong> ${msg}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
