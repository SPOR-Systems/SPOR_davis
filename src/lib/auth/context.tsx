"use client";

import React, { createContext, useContext, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { forgetAll } from "@/lib/clientCache";

interface User {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MEMBER";
}

interface Organization {
  id: string;
  name: string;
  slug: string;
}

interface AuthState {
  user: User | null;
  organization: Organization | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
  login: (token: string, user: User, org: Organization) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    organization: null,
    isLoading: true,
    isAuthenticated: false,
  });
  const router = useRouter();

  const refreshUser = async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        setState({
          user: data.user,
          organization: data.organization,
          isLoading: false,
          isAuthenticated: true,
        });
      } else {
        setState({
          user: null,
          organization: null,
          isLoading: false,
          isAuthenticated: false,
        });
      }
    } catch (error) {
      console.error("Failed to fetch user session", error);
      setState({
        user: null,
        organization: null,
        isLoading: false,
        isAuthenticated: false,
      });
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  const login = (token: string, user: User, org: Organization) => {
    // Note: HttpOnly cookie is set by the server response
    setState({
      user,
      organization: org,
      isLoading: false,
      isAuthenticated: true,
    });
  };

  const logout = async () => {
    // Whoever signs in next on this machine must not find the last person's
    // documents sitting in storage.
    forgetAll();
    // Call an endpoint to clear the cookie, or just clear client state 
    // and rely on server returning 401. Since we set HttpOnly cookie, we should have a logout endpoint.
    // For now, we'll just clear state and redirect. A real logout endpoint would be better.
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (e) {
      console.error(e);
    }
    
    setState({
      user: null,
      organization: null,
      isLoading: false,
      isAuthenticated: false,
    });
    router.push("/login");
  };

  return (
    <AuthContext.Provider value={{ ...state, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
