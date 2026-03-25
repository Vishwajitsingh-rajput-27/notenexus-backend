const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  // Check for Bearer token in Authorization header
  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    console.log('[auth] No token provided');
    return res.status(401).json({ message: 'Not authorised — no token' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    console.log('[auth] Token decoded, userId:', decoded.id);

    // Find user by ID from token
    const user = await User.findById(decoded.id).select('-password');
    
    if (!user) {
      console.log('[auth] User not found for id:', decoded.id);
      return res.status(401).json({ message: 'User not found' });
    }

    // Attach user to request object
    req.user = user;
    
    console.log('[auth] ✅ User authenticated:', user._id.toString(), user.email);
    
    next();
  } catch (err) {
    console.error('[auth] Token verification failed:', err.message);
    res.status(401).json({ message: 'Token invalid or expired' });
  }
};

module.exports = protect;
