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
const reporterCooldowns = {};
const chameleonPending = {};

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
    console.log(`[접속] Socket ID: ${socket.id}`);

    socket.on('createRoom', ({ username }) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId, players: [], status: 'waiting', masterId: socket.id,
            settings: { maxPlayers: 8, mafiaCount: 0, doctorCount: 1, policeCount: 1, chameleonCount: 1 }
        };
        socket.emit('roomCreated', { roomId });
    });

    socket.on('joinRoom', ({ roomId, username }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMessage', '방이 없습니다.');
        
        // 중복 접속 방지: 이미 해당 소켓이 플레이어 목록에 있는지 확인
        if (room.players.find(p => p.id === socket.id)) return;

        socket.join(roomId);
        room.players.push({ id: socket.id, username, role: null, isAlive: true, isMaster: room.masterId === socket.id });
        
        io.to(roomId).emit('roomData', room);
        io.to(roomId).emit('receiveMessage', { username: '시스템', message: `[ ${username} ] 님이 접속했습니다.`, type: 'system' });
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // 게임 시작 전 실제 인원 재확인 (로그로 추적 가능하게)
        console.log(`[게임 시작] 방 코드: ${roomId}, 인원: ${room.players.length}명`);
        
        room.status = 'night';
        const players = room.players;
        const roles = ['chameleon']; // 카멜레온 1명
        while (roles.length < players.length) roles.push('citizen');
        roles.sort(() => Math.random() - 0.5);

        players.forEach((p, i) => {
            p.role = roles[i];
            p.isAlive = true;
            io.to(p.id).emit('assignRole', { role: p.role });
        });

        io.to(roomId).emit('gameStarted', { status: room.status, players: room.players });
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) {
                console.log(`[퇴장] 유저: ${room.players[idx].username}, 방: ${roomId}`);
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