import React, { useState } from 'react';
import './Login.css';

const LoginView = ({ onLogin }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // 🔑 Change this to your desired password
  const CORRECT_PASSWORD = 'merit2026';

  const handleLogin = (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    setTimeout(() => {
      if (password === CORRECT_PASSWORD) {
        sessionStorage.setItem('rfp_auth', 'true');
        onLogin();
      } else {
        setError('Incorrect password. Please try again.');
        setPassword('');
      }
      setLoading(false);
    }, 500);
  };

  return (
    <div className="login-page">
      <div className="login-bg">
        <div className="login-bg-shape shape-1" />
        <div className="login-bg-shape shape-2" />
        <div className="login-bg-shape shape-3" />
      </div>

      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
              <rect width="44" height="44" rx="12" fill="#5b5fc7" />
              <path d="M9 31V15h5v6h10v-6h5v16h-5v-7H14v7H9z" fill="white" />
              <rect x="27" y="22" width="8" height="9" rx="1.5" fill="white" opacity="0.65" />
            </svg>
          </div>
          <h1 className="login-title">The MERIT Hotel</h1>
          <p className="login-subtitle">RFP Response System</p>
        </div>

        <form onSubmit={handleLogin} className="login-form">
          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter access password"
              required
              autoFocus
              autoComplete="current-password"
            />
          </div>

          {error && (
            <div className="login-error">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 110-2 1 1 0 010 2z"/>
              </svg>
              {error}
            </div>
          )}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? <span className="login-spinner" /> : 'Sign In →'}
          </button>
        </form>

        <p className="login-footer">
          Access restricted to authorized hotel staff only.
        </p>
      </div>
    </div>
  );
};

export default LoginView;
