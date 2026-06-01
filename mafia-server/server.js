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

    // 방 생성 (클라이언트에서 설정값을 받도록 수정)
    socket.on('createRoom', ({ username, settings }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId, 
            players: [], 
            status: 'waiting', 
            masterId: socket.id,
            // 클라이언트에서 settings를 보내면 적용, 없으면 기본값(마피아 0) 사용
            settings: settings || { maxPlayers: 8, mafiaCount: 0, chameleonCount: 1 } 
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

    // 게임 시작 및 직업 분배 (설정값 기반 동적 분배)
    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        room.status = 'night';
        const players = room.players;
        
        // 방의 설정값에서 마피아와 카멜레온 수를 가져옴
        const { mafiaCount, chameleonCount } = room.settings;
        
        // 직업 카드 풀 동적 생성
        const roles = [];
        
        for (let i = 0; i < mafiaCount; i++) roles.push('mafia');
        for (let i = 0; i < chameleonCount; i++) roles.push('chameleon');
        
        // 나머지 부족한 인원은 전부 시민으로 채움
        while (roles.length < players.length) roles.push('citizen');
        
        // 직업 섞기
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