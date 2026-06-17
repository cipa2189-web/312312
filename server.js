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

// groupName -> { name, owner, members: Set<string> }
const groups = new Map();

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'simple-messenger',
    usersOnline: users.size,
    groups: Array.from(groups.keys()).sort()
  });
});

function userList() {
  return Array.from(users.keys()).sort();
}

function groupsForUser(username) {
  return Array.from(groups.values())
    .filter(group => group.members.has(username))
    .map(group => ({
      name: group.name,
      owner: group.owner,
      members: Array.from(group.members).sort()
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isValidName(value) {
  return /^[a-zA-Zа-яА-ЯёЁ0-9_\-. ]+$/.test(value);
}

function broadcastUsers() {
  io.emit('users', userList());
}

function emitGroupsTo(username) {
  const socketId = users.get(username);
  if (socketId) {
    io.to(socketId).emit('groups', groupsForUser(username));
  }
}

function broadcastGroupsToAllOnline() {
  for (const username of users.keys()) emitGroupsTo(username);
}

function joinUserToGroupRoom(username, groupName) {
  const socketId = users.get(username);
  const socket = socketId ? io.sockets.sockets.get(socketId) : null;
  if (socket) socket.join('group:' + groupName);
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

    // Подключаем пользователя к комнатам его групп.
    for (const group of groups.values()) {
      if (group.members.has(username)) socket.join('group:' + group.name);
    }

    callback && callback({
      ok: true,
      username,
      users: userList(),
      groups: groupsForUser(username)
    });

    broadcastUsers();
    emitGroupsTo(username);
    console.log('login', username);
  });

  socket.on('create_group', (rawName, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const name = String(rawName || '').trim();
    if (!name || name.length < 2 || name.length > 30) {
      return callback && callback({ ok: false, error: 'Название группы должно быть от 2 до 30 символов' });
    }
    if (!isValidName(name)) {
      return callback && callback({ ok: false, error: 'Можно использовать буквы, цифры, _, -, . и пробел' });
    }
    if (groups.has(name)) {
      return callback && callback({ ok: false, error: 'Такая группа уже есть' });
    }

    groups.set(name, {
      name,
      owner: username,
      members: new Set([username])
    });

    socket.join('group:' + name);
    emitGroupsTo(username);
    callback && callback({ ok: true, group: name });
    console.log('create_group', name, 'owner', username);
  });

  socket.on('add_user_to_group', (payload, callback) => {
    const username = socket.data.username;
    if (!username) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const groupName = String(payload?.group || '').trim();
    const userToAdd = String(payload?.user || '').trim();
    const group = groups.get(groupName);

    if (!group) {
      return callback && callback({ ok: false, error: 'Такой группы нет' });
    }
    if (!group.members.has(username)) {
      return callback && callback({ ok: false, error: 'Вы не участник этой группы' });
    }
    if (!users.has(userToAdd)) {
      return callback && callback({ ok: false, error: 'Пользователь не онлайн' });
    }
    if (group.members.has(userToAdd)) {
      return callback && callback({ ok: false, error: 'Пользователь уже в группе' });
    }

    group.members.add(userToAdd);
    joinUserToGroupRoom(userToAdd, groupName);

    emitGroupsTo(userToAdd);
    emitGroupsTo(username);

    const systemMessage = {
      type: 'group',
      group: groupName,
      from: 'Система',
      text: `${username} добавил ${userToAdd} в группу`,
      time: Date.now()
    };
    io.to('group:' + groupName).emit('group_message', systemMessage);

    callback && callback({ ok: true, group: groupName, user: userToAdd });
    console.log('add_user_to_group', userToAdd, 'to', groupName, 'by', username);
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

  socket.on('group_message', (payload, callback) => {
    const from = socket.data.username;
    if (!from) {
      return callback && callback({ ok: false, error: 'Сначала выполните вход' });
    }

    const groupName = String(payload?.group || '').trim();
    const text = String(payload?.text || '').trim();
    const group = groups.get(groupName);

    if (!group) {
      return callback && callback({ ok: false, error: 'Такой группы нет' });
    }
    if (!group.members.has(from)) {
      return callback && callback({ ok: false, error: 'Вы не участник этой группы' });
    }
    if (!text || text.length > 1000) {
      return callback && callback({ ok: false, error: 'Сообщение пустое или слишком длинное' });
    }

    const message = { type: 'group', group: groupName, from, text, time: Date.now() };
    io.to('group:' + groupName).emit('group_message', message);
    callback && callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const username = sockets.get(socket.id);
    if (username) {
      users.delete(username);
      sockets.delete(socket.id);
      broadcastUsers();
      broadcastGroupsToAllOnline();
      console.log('logout', username);
    }
    console.log('disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
