import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';

export default function AdminBlogSources() {
  const { id } = useParams<{ id: string }>();

  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['admin-sources', id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from('sources').select('*').eq('article_id', id).order('retrieved_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!id,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Article Sources</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>URL</TableHead>
            <TableHead>Allowed</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead>Retrieved</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={5} className="text-center py-8">Loading...</TableCell></TableRow>
          ) : sources.length === 0 ? (
            <TableRow><TableCell colSpan={5} className="text-center py-8">No sources</TableCell></TableRow>
          ) : (
            sources.map((s: any) => (
              <TableRow key={s.id}>
                <TableCell>{s.source_title || '—'}</TableCell>
                <TableCell>
                  <a href={s.source_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline max-w-xs truncate">
                    {s.source_url} <ExternalLink className="h-3 w-3" />
                  </a>
                </TableCell>
                <TableCell><Badge variant={s.allowed_to_use ? 'default' : 'destructive'}>{s.allowed_to_use ? 'Yes' : 'No'}</Badge></TableCell>
                <TableCell className="max-w-xs truncate">{s.notes || '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{new Date(s.retrieved_at).toLocaleDateString()}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
