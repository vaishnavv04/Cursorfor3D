import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

/**
 * Hook to fetch conversations list
 */
export function useConversations() {
  const { token, apiBase } = useAuth();
  const baseUrl = apiBase || "http://localhost:5000";

  return useQuery({
    queryKey: ['conversations'],
    queryFn: async () => {
      const res = await fetch(`${baseUrl}/api/conversations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired');
        }
        throw new Error('Failed to fetch conversations');
      }
      const data = await res.json();
      return data.conversations || [];
    },
    enabled: !!token, // Only fetch if token exists
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2,
  });
}

/**
 * Hook to fetch a single conversation with messages
 */
export function useConversation(conversationId) {
  const { token, apiBase } = useAuth();
  const baseUrl = apiBase || "http://localhost:5000";

  return useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      
      const res = await fetch(`${baseUrl}/api/conversation/${conversationId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired');
        }
        throw new Error('Failed to fetch conversation');
      }
      const data = await res.json();
      return data;
    },
    enabled: !!token && !!conversationId,
    staleTime: 2 * 60 * 1000, // 2 minutes
    retry: 2,
  });
}

/**
 * Hook to create a new conversation
 */
export function useCreateConversation() {
  const { token, apiBase } = useAuth();
  const queryClient = useQueryClient();
  const baseUrl = apiBase || "http://localhost:5000";

  return useMutation({
    mutationFn: async (title) => {
      const res = await fetch(`${baseUrl}/api/conversation/new`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ title })
      });
      
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired');
        }
        const data = await res.json();
        throw new Error(data.error || 'Failed to create conversation');
      }
      
      const data = await res.json();
      return data.conversation;
    },
    onSuccess: () => {
      // Invalidate conversations list to refetch
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

/**
 * Hook to delete a conversation
 */
export function useDeleteConversation() {
  const { token, apiBase } = useAuth();
  const queryClient = useQueryClient();
  const baseUrl = apiBase || "http://localhost:5000";

  return useMutation({
    mutationFn: async (conversationId) => {
      const res = await fetch(`${baseUrl}/api/conversation/${conversationId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error('Session expired');
        }
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete conversation');
      }
      
      return conversationId;
    },
    onSuccess: () => {
      // Invalidate conversations list to refetch
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

