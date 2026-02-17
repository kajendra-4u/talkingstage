const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: 100 * 1024 * 1024 // 100MB max per message
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Increase payload limit for large files
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Simpan data room sementara (in-memory)
const rooms = new Map();

// Broadcast pesan ke semua client di room tertentu
function broadcastToRoom(roomCode, message, excludeWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;

    let successCount = 0;
    room.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
                successCount++;
            } catch (error) {
                console.error('Error broadcasting to client:', error);
            }
        }
    });
    console.log(`📡 Broadcast ke ${successCount} client di room ${roomCode}`);
}

// Kirim pesan ke client tertentu
function sendToClient(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(message));
            return true;
        } catch (error) {
            console.error('Error sending to client:', error);
            return false;
        }
    }
    return false;
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    let currentRoom = null;
    let username = null;

    const clientId = Math.random().toString(36).substr(2, 9);
    console.log(`✅ Client baru terhubung [${clientId}] dari ${req.socket.remoteAddress}`);

    // Kirim ping setiap 30 detik untuk keep-alive
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);

    ws.on('pong', () => {
        console.log(`💓 Pong dari [${clientId}]`);
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log(`📨 [${clientId}] ${username || 'Unknown'} -> ${message.type}`);

            switch (message.type) {
                case 'create_room':
                    const createRoomCode = message.roomCode.toUpperCase().trim();
                    
                    if (!createRoomCode || createRoomCode.length !== 5) {
                        sendToClient(ws, {
                            type: 'error',
                            message: 'Kode room harus 5 karakter!'
                        });
                        return;
                    }

                    if (rooms.has(createRoomCode)) {
                        sendToClient(ws, {
                            type: 'error',
                            message: 'Kode room sudah digunakan! Gunakan kode lain.'
                        });
                        return;
                    }

                    rooms.set(createRoomCode, {
                        clients: new Set([ws]),
                        users: new Map([[ws, message.username]]),
                        createdAt: new Date()
                    });

                    currentRoom = createRoomCode;
                    username = message.username;

                    console.log(`✅ Room dibuat: ${createRoomCode} oleh ${username} [${clientId}]`);

                    sendToClient(ws, {
                        type: 'room_created',
                        roomCode: createRoomCode,
                        username: username
                    });

                    sendToClient(ws, {
                        type: 'user_count',
                        count: 1
                    });
                    break;

                case 'join_room':
                    const joinRoomCode = message.roomCode.toUpperCase().trim();
                    
                    console.log(`🔍 [${clientId}] Mencoba join room: ${joinRoomCode}`);

                    if (!rooms.has(joinRoomCode)) {
                        sendToClient(ws, {
                            type: 'error',
                            message: 'Room tidak ditemukan! Pastikan kode benar.'
                        });
                        return;
                    }

                    const room = rooms.get(joinRoomCode);
                    room.clients.add(ws);
                    room.users.set(ws, message.username);

                    currentRoom = joinRoomCode;
                    username = message.username;

                    console.log(`✅ ${username} [${clientId}] join room: ${joinRoomCode}`);

                    sendToClient(ws, {
                        type: 'room_joined',
                        roomCode: joinRoomCode,
                        username: username
                    });

                    broadcastToRoom(joinRoomCode, {
                        type: 'user_joined',
                        username: username,
                        userCount: room.clients.size
                    }, ws);

                    sendToClient(ws, {
                        type: 'user_count',
                        count: room.clients.size
                    });
                    break;

                case 'send_message':
                    if (!currentRoom || !rooms.has(currentRoom)) {
                        sendToClient(ws, {
                            type: 'error',
                            message: 'Anda tidak berada di room manapun'
                        });
                        return;
                    }

                    const chatMessage = {
                        type: 'new_message',
                        username: username,
                        message: message.message,
                        messageType: message.messageType || 'text', // text, image, video, file, voice
                        fileData: message.fileData || null,
                        fileName: message.fileName || null,
                        fileSize: message.fileSize || null,
                        mimeType: message.mimeType || null,
                        duration: message.duration || null, // for voice notes
                        timestamp: new Date().toLocaleTimeString('id-ID', { 
                            hour: '2-digit', 
                            minute: '2-digit' 
                        })
                    };

                    const currentRoomData = rooms.get(currentRoom);
                    let sentCount = 0;
                    currentRoomData.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            try {
                                client.send(JSON.stringify(chatMessage));
                                sentCount++;
                            } catch (error) {
                                console.error('Error sending message to client:', error);
                            }
                        }
                    });
                    console.log(`✅ Pesan terkirim ke ${sentCount}/${currentRoomData.clients.size} client`);
                    break;

                case 'leave_room':
                    console.log(`👋 [${clientId}] ${username} meninggalkan room ${currentRoom}`);

                    if (currentRoom && rooms.has(currentRoom)) {
                        const leaveRoom = rooms.get(currentRoom);
                        leaveRoom.clients.delete(ws);
                        leaveRoom.users.delete(ws);

                        broadcastToRoom(currentRoom, {
                            type: 'user_left',
                            username: username,
                            userCount: leaveRoom.clients.size
                        });

                        if (leaveRoom.clients.size === 0) {
                            rooms.delete(currentRoom);
                            console.log(`🗑️ Room ${currentRoom} dihapus (kosong)`);
                        }

                        sendToClient(ws, {
                            type: 'left_room'
                        });

                        currentRoom = null;
                        username = null;
                    }
                    break;
            }
        } catch (error) {
            console.error(`❌ Error parsing message dari [${clientId}]:`, error);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Client terputus: ${username} [${clientId}]`);
        clearInterval(pingInterval);

        if (currentRoom && rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);
            room.clients.delete(ws);
            room.users.delete(ws);

            broadcastToRoom(currentRoom, {
                type: 'user_left',
                username: username,
                userCount: room.clients.size
            });

            if (room.clients.size === 0) {
                rooms.delete(currentRoom);
                console.log(`🗑️ Room ${currentRoom} dihapus (kosong)`);
            }
        }
    });

    ws.on('error', (error) => {
        console.error(`❌ WebSocket error [${clientId}]:`, error);
    });
});

// Cleanup rooms setiap 1 jam
setInterval(() => {
    rooms.forEach((room, roomCode) => {
        if (room.clients.size === 0) {
            rooms.delete(roomCode);
            console.log(`🧹 Cleanup: Room ${roomCode} dihapus`);
        }
    });
    console.log(`🧹 Cleanup selesai. Room aktif: ${rooms.size}`);
}, 3600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Server berjalan di http://localhost:${PORT}`);
    console.log(`📡 WebSocket server siap menerima koneksi`);
    console.log(`📁 Max file size: 100MB`);
});