// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
let server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};
const roomActions = {};
const roomVotes = {};
const lastMessageTime = {};

function generateRoomCode() {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            code += characters.charAt(Math.floor(Math.random() * characters.length));
        }
    } while (rooms[code]);
    return code;
}

io.on('connection', (socket) => {
    socket.on('createRoom', ({ username }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId, players: [], status: 'waiting', masterId: socket.id,
            settings: { maxPlayers: 8, mafiaCount: 1, doctorCount: 1, policeCount: 1, saboteurCount: 1 }
        };
        socket.emit('roomCreated', { roomId });
    });

    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '방이 없습니다.');
        if (room.players.find(p => p.id === socket.id)) return;

        socket.join(roomId);
        room.players.push({ id: socket.id, username, role: null, isAlive: true, isMaster: room.masterId === socket.id, canVote: true });
        
        io.to(roomId).emit('roomData', room);
        io.to(roomId).emit('receiveMessage', { username: '시스템', message: `[ ${username} ] 님이 접속했습니다.`, type: 'system' });
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        room.status = 'night';
        const players = room.players;
        const { mafiaCount, doctorCount, policeCount, saboteurCount } = room.settings;
        
        const roles = [];
        for (let i = 0; i < mafiaCount; i++) roles.push('mafia');
        for (let i = 0; i < doctorCount; i++) roles.push('doctor');
        for (let i = 0; i < policeCount; i++) roles.push('police');
        for (let i = 0; i < saboteurCount; i++) roles.push('saboteur');
        while (roles.length < players.length) roles.push('citizen');
        roles.sort(() => Math.random() - 0.5);

        players.forEach((p, i) => {
            p.role = roles[i];
            p.isAlive = true;
            p.canVote = true; // 투표권 초기화
            io.to(p.id).emit('assignRole', { role: p.role });
        });

        io.to(roomId).emit('gameStarted', { status: room.status, players: room.players });
    });

    // 방해꾼 액션: 투표권 박탈
    socket.on('saboteurAction', ({ roomId, targetId }) => {
        if (!roomActions[roomId]) roomActions[roomId] = {};
        roomActions[roomId].saboteurTarget = targetId;
        // 밤 결과 연산 로직으로 연결
    });

    // 투표 이벤트 (방해꾼 능력 적용)
    socket.on('dayVote', ({ roomId, targetId }) => {
        const room = rooms[roomId];
        const voter = room.players.find(p => p.id === socket.id);
        
        // 투표권 확인
        if (!voter || !voter.canVote) {
            return socket.emit('errorMessage', '당신은 방해꾼의 저주로 투표할 수 없습니다!');
        }

        if (!roomVotes[roomId]) roomVotes[roomId] = {};
        roomVotes[roomId][socket.id] = targetId;
        io.to(roomId).emit('voteProgress', { voterName: voter.username });
    });

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
server.listen(PORT, () => console.log(`서버 가동 중: 포트 ${PORT}`));