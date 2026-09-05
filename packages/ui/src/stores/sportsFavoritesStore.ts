/**
 * Sports Favorites Store - Zustand store with localStorage persistence
 *
 * Stores favorite teams for the Sports Hub.
 * Persists across sessions using localStorage.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SportsTeam } from '@ynotv/core';

export interface FavoriteTeam extends SportsTeam {
  addedAt: number;
  isPinned?: boolean;
}

export function matchesFavorite(f: FavoriteTeam, teamId: string, leagueId?: string): boolean {
  if (f.id !== teamId) return false;
  // If either has no leagueId (legacy favorite), fall back to matching by team id
  if (!leagueId || !f.leagueId) return true;
  return f.leagueId.toLowerCase() === leagueId.toLowerCase();
}

interface SportsFavoritesState {
  favorites: FavoriteTeam[];
  addFavorite: (team: SportsTeam) => void;
  removeFavorite: (teamId: string, leagueId?: string) => void;
  isFavorite: (teamId: string, leagueId?: string) => boolean;
  clearFavorites: () => void;
  reorderFavorites: (newFavorites: FavoriteTeam[]) => void;
  moveFavorite: (teamId: string, direction: 'up' | 'down', leagueId?: string) => void;
  togglePinFavorite: (teamId: string, leagueId?: string) => void;
}

export const useSportsFavoritesStore = create<SportsFavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      
      addFavorite: (team) => set((state) => {
        if (state.favorites.some(f => matchesFavorite(f, team.id, team.leagueId))) {
          return state;
        }
        return {
          favorites: [...state.favorites, { ...team, addedAt: Date.now() }]
        };
      }),
      
      removeFavorite: (teamId, leagueId) => set((state) => ({
        favorites: state.favorites.filter(f => !matchesFavorite(f, teamId, leagueId))
      })),
      
      isFavorite: (teamId, leagueId) => get().favorites.some(f => matchesFavorite(f, teamId, leagueId)),
      
      clearFavorites: () => set({ favorites: [] }),

      reorderFavorites: (newFavorites) => set({ favorites: newFavorites }),

      moveFavorite: (teamId, direction, leagueId) => set((state) => {
        const index = state.favorites.findIndex(f => matchesFavorite(f, teamId, leagueId));
        if (index === -1) return state;
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= state.favorites.length) return state;

        const updated = [...state.favorites];
        const [moved] = updated.splice(index, 1);
        updated.splice(targetIndex, 0, moved);
        return { favorites: updated };
      }),

      togglePinFavorite: (teamId, leagueId) => set((state) => ({
        favorites: state.favorites.map(f =>
          matchesFavorite(f, teamId, leagueId) ? { ...f, isPinned: !f.isPinned } : f
        )
      })),
    }),
    {
      name: 'sports-favorites',
    }
  )
);

export const useFavoriteTeams = () => useSportsFavoritesStore((s) => s.favorites);
export const useAddFavorite = () => useSportsFavoritesStore((s) => s.addFavorite);
export const useRemoveFavorite = () => useSportsFavoritesStore((s) => s.removeFavorite);
export const useIsFavorite = (teamId: string, leagueId?: string) => useSportsFavoritesStore((s) => s.isFavorite(teamId, leagueId));
export const useMoveFavorite = () => useSportsFavoritesStore((s) => s.moveFavorite);
export const useTogglePinFavorite = () => useSportsFavoritesStore((s) => s.togglePinFavorite);
export const useReorderFavorites = () => useSportsFavoritesStore((s) => s.reorderFavorites);
