const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// username -> socket.id
const users = new Map();
// socket.id -> username
const sockets = new Map();
// список общих чатов/комнат
const rooms = new Set(['Общий']);

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'simple-messenger',
    usersOnline: users.size,
    rooms: Array.from(rooms).sort()
  });
});

function userList() {
  return Array.from(users.keys()).sort();
}

function roomList() {
  return Array.from(rooms).sort();
}

function broadcastUsers() {
  io.emit('users', userList());
}

function broadcastRooms() {
  io.emit('rooms', roomList());
}

function isValidName(value) {
  return /^[a-zA-Zа-яА-ЯёЁ0-9_\-. ]+$/.test(value);
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  socket.on('login', (rawUsername, callback) => {
    const username = String(rawUsername || '').trim();

    if (!username || username.length < 2 || username.length > 20) {
      return callback && callback({ ok: false, error: 'Имя должно быть от 2 до 20 символов' });
    }
    if (!isValidName(username)) {
      return callback && callback({ ok: false, error: 'Можно использовать буквы, цифры, _, -, . и пробел' });
    }
    if (users.has(username)) {
      return callback && callback({ ok: false, error: 'Такой пользователь уже онлайн' });
    }

    users.set(username, socket.id);
    sockets.set(socket.id, username);
    socket.data.username = username;

    // Автоматически подключаем ко всем существующим общим чатам.
    for (const room of rooms) socket.join('room:' + room);

    callback && callback({ ok: true, username, users: userList(), rooms: roomList() });
    broadcastUsers();
    socket.emit('rooms', roomList());
    console.log('login', username);
  });

  socket.on('create_room', (rawRoom, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const room = String(rawRoom || '').trim();
    if (!room || room.length < 2 || room.length > 30) {
      return callback && callback({ ok: false, error: 'Название чата должно быть от 2 до 30 символов' });
    }
    if (!isValidName(room)) {
      return callback && callback({ ok: false, error: 'Можно использовать буквы, цифры, _, -, . и пробел' });
    }

    rooms.add(room);
    for (const [, socketId] of users) {
      io.sockets.sockets.get(socketId)?.join('room:' + room);
    }

    broadcastRooms();
    callback && callback({ ok: true, room });
  });

  socket.on('join_room', (rawRoom, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const room = String(rawRoom || '').trim();
    if (!rooms.has(room)) {
      return callback && callback({ ok: false, error: 'Такого общего чата нет' });
    }

    socket.join('room:' + room);
    callback && callback({ ok: true, room });
  });

  socket.on('private_message', (payload, callback) => {
    const from = socket.data.username;
    if (!from) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const to = String(payload?.to || '').trim();
    const text = String(payload?.text || '').trim();

    if (!to || !users.has(to)) {
      return callback && callback({ ok: false, error: 'Получатель не онлайн' });
    }
    if (!text || text.length > 1000) {
      return callback && callback({ ok: false, error: 'Сообщение пустое или слишком длинное' });
    }

    const message = { type: 'private', from, to, text, time: Date.now() };

    io.to(users.get(to)).emit('private_message', message);
    socket.emit('private_message', message);
    callback && callback({ ok: true });
  });

  socket.on('room_message', (payload, callback) => {
    const from = socket.data.username;
    if (!from) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const room = String(payload?.room || '').trim();
    const text = String(payload?.text || '').trim();

    if (!room || !rooms.has(room)) {
      return callback && callback({ ok: false, error: 'Такого общего чата нет' });
    }
    if (!text || text.length > 1000) {
      return callback && callback({ ok: false, error: 'Сообщение пустое или слишком длинное' });
    }

    const message = { type: 'room', room, from, text, time: Date.now() };
    io.to('room:' + room).emit('room_message', message);
    callback && callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const username = sockets.get(socket.id);
    if (username) {
      users.delete(username);
      sockets.delete(socket.id);
      broadcastUsers();
      console.log('logout', username);
    }
    console.log('disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
