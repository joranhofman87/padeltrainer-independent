import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Plus, Play, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

const LOCALES = ['en', 'nl', 'es', 'de', 'fr'];

export default function AdminBlogTopics() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ primary_keyword: '', locales: ['en', 'nl'], angle: '', notes: '' });

  const { data: topics = [], isLoading } = useQuery({
    queryKey: ['admin-topics'],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from('content_topics').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error } = await (supabase as any).from('content_topics').insert({
        primary_keyword: form.primary_keyword,
        locales: form.locales,
        angle: form.angle || null,
        notes: form.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-topics'] });
      setDialogOpen(false);
      setForm({ primary_keyword: '', locales: ['en', 'nl'], angle: '', notes: '' });
      toast.success('Topic added');
    },
  });

  const generateMutation = useMutation({
    mutationFn: async (topicId: string) => {
      const { error } = await supabase.functions.invoke('generate-blog-article', {
        body: { topic_id: topicId },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-topics'] });
      toast.success('Article generation started');
    },
    onError: (err: any) => toast.error(err.message || 'Generation failed'),
  });

  const statusColor = (s: string) => s === 'done' ? 'default' : s === 'in_progress' ? 'secondary' : s === 'failed' ? 'destructive' : 'outline';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Content Topics</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" /> Add Topic</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add Topic</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Primary Keyword</Label>
                <Input value={form.primary_keyword} onChange={e => setForm(f => ({ ...f, primary_keyword: e.target.value }))} placeholder="e.g. padel serve technique" />
              </div>
              <div>
                <Label>Angle</Label>
                <Input value={form.angle} onChange={e => setForm(f => ({ ...f, angle: e.target.value }))} placeholder="e.g. beginner, tips, how-to" />
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} />
              </div>
              <div>
                <Label>Target Locales</Label>
                <div className="flex gap-2 mt-1">
                  {LOCALES.map(l => (
                    <Badge
                      key={l}
                      variant={form.locales.includes(l) ? 'default' : 'outline'}
                      className="cursor-pointer"
                      onClick={() => setForm(f => ({
                        ...f,
                        locales: f.locales.includes(l) ? f.locales.filter(x => x !== l) : [...f.locales, l]
                      }))}
                    >
                      {l.toUpperCase()}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button onClick={() => createMutation.mutate()} disabled={!form.primary_keyword || createMutation.isPending}>
                {createMutation.isPending ? 'Adding...' : 'Add Topic'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Keyword</TableHead>
            <TableHead>Angle</TableHead>
            <TableHead>Locales</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={5} className="text-center py-8">Loading...</TableCell></TableRow>
          ) : topics.length === 0 ? (
            <TableRow><TableCell colSpan={5} className="text-center py-8">No topics yet</TableCell></TableRow>
          ) : (
            topics.map((topic: any) => (
              <TableRow key={topic.id}>
                <TableCell className="font-medium">{topic.primary_keyword}</TableCell>
                <TableCell>{topic.angle || '—'}</TableCell>
                <TableCell>
                  <div className="flex gap-1">{topic.locales?.map((l: string) => <Badge key={l} variant="outline" className="text-xs">{l}</Badge>)}</div>
                </TableCell>
                <TableCell><Badge variant={statusColor(topic.status)}>{topic.status}</Badge></TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => generateMutation.mutate(topic.id)}
                    disabled={topic.status === 'in_progress' || generateMutation.isPending}
                  >
                    {generateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
                    Generate
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
