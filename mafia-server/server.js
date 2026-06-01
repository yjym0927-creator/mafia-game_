const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
let server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms[code]);
    return code;
}

io.on('connection', (socket) => {
    socket.on('createRoom', ({ username }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId, players: [], status: 'waiting', masterId: socket.id,
            settings: { maxPlayers: 8, mafiaCount: 0, chameleonCount: 1, doctorCount: 0, policeCount: 0, jesterCount: 0, reporterCount: 0 }
        };
        socket.emit('roomCreated', { roomId });
    });

    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '방이 존재하지 않습니다.');
        socket.join(roomId);
        room.players.push({ id: socket.id, username, role: null, isAlive: true });
        io.to(roomId).emit('roomData', room);
    });

    // [핵심] 설정 변경 동기화
    socket.on('updateSettings', ({ roomId, settings }) => {
        if (rooms[roomId]) {
            rooms[roomId].settings = settings;
            io.to(roomId).emit('settingsUpdated', settings);
        }
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        room.status = 'night';
        const s = room.settings;
        let roles = [];
        
        // 설정값 기반 직업 리스트 생성
        for(let i=0; i<s.mafiaCount; i++) roles.push('mafia');
        for(let i=0; i<s.chameleonCount; i++) roles.push('chameleon');
        for(let i=0; i<s.doctorCount; i++) roles.push('doctor');
        for(let i=0; i<s.policeCount; i++) roles.push('police');
        for(let i=0; i<s.jesterCount; i++) roles.push('jester');
        for(let i=0; i<s.reporterCount; i++) roles.push('reporter');
        
        while (roles.length < room.players.length) roles.push('citizen');
        roles.sort(() => Math.random() - 0.5);

        room.players.forEach((p, i) => {
            p.role = roles[i];
            io.to(p.id).emit('assignRole', { role: p.role });
        });
        io.to(roomId).emit('gameStarted', { status: room.status, players: room.players });
    });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 서버 가동 중: ${PORT}`));