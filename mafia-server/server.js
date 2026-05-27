const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
let server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};

// 유틸: 방 코드 생성
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms[code]);
    return code;
}

io.on('connection', (socket) => {
    console.log(`[연결] Socket ID: ${socket.id}`);

    // 방 생성
    socket.on('createRoom', ({ username }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId, players: [], status: 'waiting', masterId: socket.id,
            settings: { maxPlayers: 8, mafiaCount: 0, chameleonCount: 1 } // 마피아 0, 카멜레온 1 고정
        };
        socket.emit('roomCreated', { roomId });
    });

    // 방 입장
    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '방이 존재하지 않습니다.');
        if (room.players.find(p => p.id === socket.id)) return;

        socket.join(roomId);
        room.players.push({ id: socket.id, username, role: null, isAlive: true });
        
        io.to(roomId).emit('roomData', room);
    });

    // 게임 시작 및 직업 분배 최적화
    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        room.status = 'night';
        const players = room.players;
        
        // 직업 카드 풀 구성
        const roles = ['chameleon']; 
        while (roles.length < players.length) roles.push('citizen');
        roles.sort(() => Math.random() - 0.5);

        // 직업 할당 및 전송
        players.forEach((p, i) => {
            p.role = roles[i] || 'citizen';
            p.isAlive = true;
            console.log(`[할당] ${p.username}: ${p.role}`);
            io.to(p.id).emit('assignRole', { role: p.role });
        });

        io.to(roomId).emit('gameStarted', { status: room.status, players: room.players });
    });

    // 퇴장 처리
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                io.to(roomId).emit('roomData', room);
                if (room.players.length === 0) delete rooms[roomId];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 서버 가동 중: ${PORT}`));