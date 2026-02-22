import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Pencil, Eye, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

const LOCALES = ['en', 'nl', 'es', 'de', 'fr'];
const STATUSES = ['draft', 'review', 'published'];

export default function AdminBlog() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filterLocale, setFilterLocale] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [search, setSearch] = useState('');

  const { data: articles = [], isLoading } = useQuery({
    queryKey: ['admin-articles', filterLocale, filterStatus],
    queryFn: async () => {
      let query = (supabase as any).from('articles').select('*').order('updated_at', { ascending: false });
      if (filterLocale !== 'all') query = query.eq('locale', filterLocale);
      if (filterStatus !== 'all') query = query.eq('status', filterStatus);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from('articles').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
      toast.success('Article deleted');
    },
  });

  const filtered = articles.filter((a: any) =>
    !search || a.title?.toLowerCase().includes(search.toLowerCase()) || a.slug?.toLowerCase().includes(search.toLowerCase())
  );

  const statusColor = (s: string) => s === 'published' ? 'default' : s === 'review' ? 'secondary' : 'outline';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Blog Articles</h1>
        <Button onClick={() => navigate('/app/admin/blog/new')}>
          <Plus className="h-4 w-4 mr-2" /> New Article
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap">
        <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="max-w-xs" />
        <Select value={filterLocale} onValueChange={setFilterLocale}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Locales</SelectItem>
            {LOCALES.map(l => <SelectItem key={l} value={l}>{l.toUpperCase()}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Cover</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Locale</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={6} className="text-center py-8">Loading...</TableCell></TableRow>
          ) : filtered.length === 0 ? (
            <TableRow><TableCell colSpan={6} className="text-center py-8">No articles found</TableCell></TableRow>
          ) : (
            filtered.map((article: any) => (
              <TableRow key={article.id}>
                <TableCell>
                  <div className="w-14 h-7 rounded overflow-hidden bg-muted flex-shrink-0">
                    {article.cover_image_url ? (
                      <img src={article.cover_image_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-[10px]">—</div>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-medium max-w-xs truncate">{article.title}</TableCell>
                <TableCell><Badge variant="outline">{article.locale?.toUpperCase()}</Badge></TableCell>
                <TableCell><Badge variant={statusColor(article.status)}>{article.status}</Badge></TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {article.published_at ? new Date(article.published_at).toLocaleDateString() : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={() => navigate(`/app/admin/blog/${article.id}`)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {article.status === 'published' && (
                      <Button variant="ghost" size="icon" asChild>
                        <a href={`/${article.locale}/blog/${article.slug}`} target="_blank" rel="noopener noreferrer">
                          <Eye className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => {
                      if (confirm('Delete this article?')) deleteMutation.mutate(article.id);
                    }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
