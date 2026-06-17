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

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'simple-private-messenger', usersOnline: users.size });
});

function userList() {
  return Array.from(users.keys()).sort();
}

function broadcastUsers() {
  io.emit('users', userList());
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  socket.on('login', (rawUsername, callback) => {
    const username = String(rawUsername || '').trim();

    if (!username || username.length < 2 || username.length > 20) {
      return callback && callback({ ok: false, error: 'Имя должно быть от 2 до 20 символов' });
    }
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9_\-.]+$/.test(username)) {
      return callback && callback({ ok: false, error: 'Можно использовать буквы, цифры, _, -, .' });
    }
    if (users.has(username)) {
      return callback && callback({ ok: false, error: 'Такой пользователь уже онлайн' });
    }

    users.set(username, socket.id);
    sockets.set(socket.id, username);
    socket.data.username = username;

    callback && callback({ ok: true, username, users: userList() });
    broadcastUsers();
    console.log('login', username);
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

    const message = {
      from,
      to,
      text,
      time: Date.now()
    };

    io.to(users.get(to)).emit('private_message', message);
    socket.emit('private_message', message); // подтверждаем отправителю, чтобы он увидел своё сообщение
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
