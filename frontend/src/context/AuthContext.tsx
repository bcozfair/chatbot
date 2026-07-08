/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';

export interface AdminUser {
  id: number;
  username: string;
  name: string;
  role: string;
}

interface AuthContextType {
  user: AdminUser | null;
  token: string | null;
  login: (token: string, user: AdminUser) => void;
  logout: (expired?: boolean) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessionExpired: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// อ่านเวลา expiry (ms) จาก JWT payload โดยไม่ต้องใช้ library — decode base64url เอง (UTF-8 safe)
function getTokenExpiryMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    const json = decodeURIComponent(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    const { exp } = JSON.parse(json);
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null; // decode ไม่ได้ → ปล่อยให้ 401 interceptor เป็น backstop
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(() => {
    const t = sessionStorage.getItem('admin_token');
    if (t) {
      const exp = getTokenExpiryMs(t);
      if (exp !== null && exp <= Date.now()) {
        // token หมดอายุตั้งแต่ก่อนเปิดแอป → ล้างทิ้ง
        sessionStorage.removeItem('admin_token');
        sessionStorage.removeItem('admin_user');
        return null;
      }
    }
    return t;
  });

  const [user, setUser] = useState<AdminUser | null>(() => {
    const storedUser = sessionStorage.getItem('admin_user');
    if (storedUser) {
      try {
        return JSON.parse(storedUser);
      } catch (err) {
        console.error('Failed to parse stored user info:', err);
        sessionStorage.removeItem('admin_token');
        sessionStorage.removeItem('admin_user');
        return null;
      }
    }
    return null;
  });

  const [sessionExpired, setSessionExpired] = useState(false);

  const isLoading = false;

  const login = (newToken: string, newUser: AdminUser) => {
    setToken(newToken);
    setUser(newUser);
    setSessionExpired(false);
    sessionStorage.setItem('admin_token', newToken);
    sessionStorage.setItem('admin_user', JSON.stringify(newUser));
  };

  const logout = useCallback((expired = false) => {
    setToken(null);
    setUser(null);
    setSessionExpired(expired);
    sessionStorage.removeItem('admin_token');
    sessionStorage.removeItem('admin_user');
  }, []);

  // Effect A — ตั้ง timer เตะออกเมื่อ token หมดอายุระหว่างเปิดหน้าค้างไว้
  useEffect(() => {
    if (!token) return;
    const exp = getTokenExpiryMs(token);
    if (exp === null) return; // อ่าน exp ไม่ได้ → พึ่ง 401 interceptor แทน
    const ms = exp - Date.now();
    if (ms <= 0) {
      logout(true);
      return;
    }
    const id = window.setTimeout(() => logout(true), ms);
    return () => window.clearTimeout(id);
  }, [token, logout]);

  // Effect B — fetch interceptor รวมศูนย์: เจอ 401 ขณะยัง login อยู่ → เด้งออก
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const res = await original(...args);
      // logout เฉพาะตอนที่ "เชื่อว่า login อยู่" — คำขอ login (token ยังเป็น null) จึงไม่โดน
      if (res.status === 401 && tokenRef.current) {
        logout(true);
      }
      return res;
    };
    return () => {
      window.fetch = original;
    };
  }, [logout]);

  const isAuthenticated = !!token;

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated, isLoading, sessionExpired }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
