/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useState } from 'react';

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
  logout: () => void;
  isAuthenticated: boolean;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem('admin_token');
  });

  const [user, setUser] = useState<AdminUser | null>(() => {
    const storedUser = localStorage.getItem('admin_user');
    if (storedUser) {
      try {
        return JSON.parse(storedUser);
      } catch (err) {
        console.error('Failed to parse stored user info:', err);
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_user');
        return null;
      }
    }
    return null;
  });

  const isLoading = false;

  const login = (newToken: string, newUser: AdminUser) => {
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('admin_token', newToken);
    localStorage.setItem('admin_user', JSON.stringify(newUser));
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
  };

  const isAuthenticated = !!token;

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isAuthenticated, isLoading }}>
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

