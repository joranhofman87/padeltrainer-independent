import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { formatDate } from '@/lib/format';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { Badge } from '@/components/ui/badge';
import { ExternalLink } from 'lucide-react';

interface SourceRow {
  id: string;
  source_title?: string | null;
  source_url?: string | null;
  allowed_to_use?: boolean | null;
  notes?: string | null;
  retrieved_at?: string | null;
}

const columns: ColumnDef<SourceRow>[] = [
  { key: 'title', header: 'Title', renderCell: (s) => s.source_title || '—' },
  {
    key: 'url',
    header: 'URL',
    renderCell: (s) => (
      <a
        href={s.source_url || undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="flex max-w-xs items-center gap-1 text-primary hover:underline"
      >
        {/* truncate must sit on a min-w-0 flex CHILD — on the flex container it never clips. */}
        <span className="min-w-0 truncate">{s.source_url}</span> <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    ),
  },
  {
    key: 'allowed',
    header: 'Allowed',
    renderCell: (s) => <Badge variant={s.allowed_to_use ? 'default' : 'destructive'}>{s.allowed_to_use ? 'Yes' : 'No'}</Badge>,
  },
  { key: 'notes', header: 'Notes', className: 'max-w-xs truncate', renderCell: (s) => s.notes || '—' },
  { key: 'retrieved', header: 'Retrieved', className: 'text-sm text-muted-foreground', renderCell: (s) => formatDate(s.retrieved_at) },
];

export default function AdminBlogSources() {
  const { id } = useParams<{ id: string }>();

  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['admin-sources', id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from('sources').select('*').eq('article_id', id).order('retrieved_at', { ascending: false });
      if (error) throw error;
      return (data || []) as SourceRow[];
    },
    enabled: !!id,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Article Sources</h1>
      <DataTable<SourceRow>
        columns={columns}
        rows={sources}
        compact
        desktopOnly={false}
        empty={isLoading ? 'Loading...' : 'No sources'}
      />
    </div>
  );
}
