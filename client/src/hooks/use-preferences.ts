import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSavedSearch,
  createTaskCategory,
  deleteSavedSearch,
  deleteTaskCategory,
  favoriteNote,
  favoriteNotebook,
  getPreferences,
  getRecentNotes,
  recordRecentRead,
  saveScratchpad,
  setTaskCategoryAssignment,
  unfavoriteNote,
  unfavoriteNotebook,
  updateTaskCategory,
} from "@/lib/api";
import { RecentNotesResponse, TaskCategoryInput, UserPreferences } from "@/lib/types";
import { announceWrite } from "@/lib/cross-tab";

export const PREFERENCES_QUERY_KEY = ["preferences"] as const;
export const RECENT_NOTES_QUERY_KEY = ["recent-notes"] as const;

export function usePreferences(enabled = true) {
  return useQuery<UserPreferences, Error>({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: getPreferences,
    staleTime: 30 * 1000,
    enabled,
  });
}

export function useRecentNotes(enabled = true) {
  return useQuery<RecentNotesResponse, Error>({
    queryKey: RECENT_NOTES_QUERY_KEY,
    queryFn: getRecentNotes,
    staleTime: 15 * 1000,
    enabled,
  });
}

export function useToggleFavoriteNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, favorited }: { id: string; favorited: boolean }) =>
      favorited ? unfavoriteNote(id) : favoriteNote(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(PREFERENCES_QUERY_KEY, updated);
      announceWrite();
    },
  });
}

export function useToggleFavoriteNotebook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, favorited }: { id: string; favorited: boolean }) =>
      favorited ? unfavoriteNotebook(id) : favoriteNotebook(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(PREFERENCES_QUERY_KEY, updated);
      announceWrite();
    },
  });
}

export function useCreateSavedSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, query }: { name: string; query: string }) => createSavedSearch(name, query),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
      announceWrite();
    },
  });
}

export function useDeleteSavedSearch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSavedSearch(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
      announceWrite();
    },
  });
}

export function useSaveScratchpad() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scratchpad: string) => saveScratchpad(scratchpad),
    onSuccess: ({ scratchpad }) => {
      queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, (prev) =>
        prev ? { ...prev, scratchpad } : prev
      );
      announceWrite();
    },
  });
}

export function useRecordRecentRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => recordRecentRead(noteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RECENT_NOTES_QUERY_KEY, refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY, refetchType: "none" });
    },
  });
}

export function useCreateTaskCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TaskCategoryInput) => createTaskCategory(input),
    onSuccess: (created) => {
      queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, (prev) =>
        prev ? { ...prev, taskCategories: [...prev.taskCategories, created] } : prev
      );
      queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
      announceWrite();
    },
  });
}

export function useUpdateTaskCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<TaskCategoryInput> }) =>
      updateTaskCategory(id, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, (prev) =>
        prev
          ? {
              ...prev,
              taskCategories: prev.taskCategories.map((c) => (c.id === updated.id ? updated : c)),
            }
          : prev
      );
      queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
      announceWrite();
    },
  });
}

export function useDeleteTaskCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTaskCategory(id),
    onSuccess: (_void, id) => {
      queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, (prev) => {
        if (!prev) return prev;
        const nextAssignments: Record<string, string> = {};
        for (const [taskKey, catId] of Object.entries(prev.taskCategoryAssignments)) {
          if (catId !== id) nextAssignments[taskKey] = catId;
        }
        return {
          ...prev,
          taskCategories: prev.taskCategories.filter((c) => c.id !== id),
          taskCategoryAssignments: nextAssignments,
        };
      });
      queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
      announceWrite();
    },
  });
}

export function useSetTaskCategoryAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskKey, categoryId }: { taskKey: string; categoryId: string | null }) =>
      setTaskCategoryAssignment(taskKey, categoryId),
    onSuccess: ({ taskCategoryAssignments }) => {
      queryClient.setQueryData<UserPreferences>(PREFERENCES_QUERY_KEY, (prev) =>
        prev ? { ...prev, taskCategoryAssignments } : prev
      );
      queryClient.invalidateQueries({ queryKey: PREFERENCES_QUERY_KEY });
      announceWrite();
    },
  });
}
