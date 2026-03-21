/**
 * NoteNexus — Socket.io Real-Time Collaboration
 * Enables: live shared note editing, class room presence, live upvotes
 */

const setupSocket = (io) => {
  // Track who is online in each "room" (room = a shared note session)
  const rooms = {}; // { roomId: Set of { socketId, userName } }

  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // ── Join a note collaboration room ───────────────────────────────────
    socket.on('join-room', ({ roomId, userName }) => {
      socket.join(roomId);
      if (!rooms[roomId]) rooms[roomId] = new Map();
      rooms[roomId].set(socket.id, userName);

      // Tell everyone in the room who just joined
      io.to(roomId).emit('room-users', {
        users: Array.from(rooms[roomId].values()),
        joined: userName,
      });
      console.log(`👥 ${userName} joined room ${roomId}`);
    });

    // ── Live note content updates ────────────────────────────────────────
    socket.on('note-update', ({ roomId, content, userName }) => {
      // Broadcast to everyone ELSE in the room
      socket.to(roomId).emit('note-updated', { content, updatedBy: userName });
    });

    // ── Typing indicator ─────────────────────────────────────────────────
    socket.on('typing', ({ roomId, userName }) => {
      socket.to(roomId).emit('user-typing', { userName });
    });

    socket.on('stop-typing', ({ roomId, userName }) => {
      socket.to(roomId).emit('user-stopped-typing', { userName });
    });

    // ── Live upvote broadcast ────────────────────────────────────────────
    socket.on('note-upvoted', ({ noteId, upvotes }) => {
      io.emit('upvote-update', { noteId, upvotes }); // broadcast to all
    });

    // ── Class hub: new shared note alert ─────────────────────────────────
    socket.on('new-shared-note', ({ title, subject, userName }) => {
      socket.broadcast.emit('shared-note-alert', { title, subject, sharedBy: userName });
    });

    // ── Disconnect ───────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      for (const [roomId, users] of Object.entries(rooms)) {
        if (users.has(socket.id)) {
          const userName = users.get(socket.id);
          users.delete(socket.id);
          io.to(roomId).emit('room-users', {
            users: Array.from(users.values()),
            left: userName,
          });
          if (users.size === 0) delete rooms[roomId];
        }
      }
      console.log(`🔌 Socket disconnected: ${socket.id}`);
    });
  });
};

module.exports = setupSocket;
