import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, Save, Globe, Loader2, ImageIcon, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

const LOCALES = ['en', 'nl', 'es', 'de', 'fr'];

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default function AdminBlogEditor() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    title: '',
    slug: '',
    locale: 'en',
    excerpt: '',
    body_md: '',
    body_html: '',
    tags: '',
    primary_keyword: '',
    meta_title: '',
    meta_description: '',
    cover_image_url: '',
    author_name: 'Padel Trainer',
    status: 'draft',
    canonical_id: crypto.randomUUID(),
  });

  const { data: article, isLoading } = useQuery({
    queryKey: ['admin-article', id],
    queryFn: async () => {
      if (isNew) return null;
      const { data, error } = await (supabase as any).from('articles').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !isNew,
  });

  // Fetch translations for non-new articles
  const { data: translations = [] } = useQuery({
    queryKey: ['admin-article-translations', article?.canonical_id],
    queryFn: async () => {
      const { data } = await (supabase as any).from('articles').select('id, locale, title, status').eq('canonical_id', article.canonical_id);
      return data || [];
    },
    enabled: !!article?.canonical_id,
  });

  useEffect(() => {
    if (article) {
      setForm({
        title: article.title || '',
        slug: article.slug || '',
        locale: article.locale || 'en',
        excerpt: article.excerpt || '',
        body_md: article.body_md || '',
        body_html: article.body_html || '',
        tags: article.tags?.join(', ') || '',
        primary_keyword: article.primary_keyword || '',
        meta_title: article.meta_title || '',
        meta_description: article.meta_description || '',
        cover_image_url: article.cover_image_url || '',
        author_name: article.author_name || 'Padel Trainer',
        status: article.status || 'draft',
        canonical_id: article.canonical_id || crypto.randomUUID(),
      });
    }
  }, [article]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean);
      const payload = {
        title: form.title,
        slug: form.slug,
        locale: form.locale,
        excerpt: form.excerpt,
        body_md: form.body_md,
        body_html: form.body_html,
        tags: tags.length > 0 ? tags : null,
        primary_keyword: form.primary_keyword || null,
        meta_title: form.meta_title || null,
        meta_description: form.meta_description || null,
        cover_image_url: form.cover_image_url || null,
        author_name: form.author_name,
        status: form.status,
        canonical_id: form.canonical_id,
        published_at: form.status === 'published' ? (article?.published_at || new Date().toISOString()) : null,
      };

      if (isNew) {
        const { data, error } = await (supabase as any).from('articles').insert(payload).select().single();
        if (error) throw error;
        return data;
      } else {
        const { data, error } = await (supabase as any).from('articles').update(payload).eq('id', id).select().single();
        if (error) throw error;
        return data;
      }
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
      queryClient.invalidateQueries({ queryKey: ['admin-article', id] });
      toast.success(isNew ? 'Article created' : 'Article saved');
      if (isNew && data?.id) navigate(`/app/admin/blog/${data.id}`, { replace: true });

      const articleId = isNew ? data?.id : id;
      if (form.status === 'published' && articleId) {
        // Auto-generate cover image if missing
        if (!form.cover_image_url) {
          toast.info('Generating cover image...');
          supabase.functions.invoke('generate-blog-cover', {
            body: { article_id: articleId },
          }).then(({ error }) => {
            if (error) {
              toast.error('Cover image generation failed');
            } else {
              toast.success('Cover image generated');
              queryClient.invalidateQueries({ queryKey: ['admin-article', id] });
            }
          });
        }

        // Auto-translate
        const currentLocale = form.locale;
        const localesToTranslate = LOCALES.filter(l => l !== currentLocale && !translations.some((t: any) => t.locale === l));
        if (localesToTranslate.length > 0) {
          toast.info(`Generating ${localesToTranslate.length} translations in the background...`);
          for (const locale of localesToTranslate) {
            supabase.functions.invoke('translate-blog-article', {
              body: { article_id: articleId, target_locale: locale },
            }).then(({ error }) => {
              if (error) {
                toast.error(`Translation to ${locale.toUpperCase()} failed`);
              } else {
                toast.success(`${locale.toUpperCase()} translation ready`);
                queryClient.invalidateQueries({ queryKey: ['admin-article-translations'] });
              }
            });
          }

          // After translations, generate covers for all locales
          setTimeout(() => {
            supabase.functions.invoke('generate-blog-cover', {
              body: { canonical_id: form.canonical_id, all_locales: true },
            }).then(({ error }) => {
              if (error) logger.error('Batch cover generation failed', error instanceof Error ? error : new Error(String(error)), { component: 'AdminBlogEditor' });
              else {
                toast.success('Cover images generated for all translations');
                queryClient.invalidateQueries({ queryKey: ['admin-article-translations'] });
              }
            });
          }, 30000); // Wait 30s for translations to complete
        }
      }
    },
    onError: (err: any) => toast.error(err.message || 'Failed to save'),
  });

  const translateMutation = useMutation({
    mutationFn: async (targetLocale: string) => {
      const { error } = await supabase.functions.invoke('translate-blog-article', {
        body: { article_id: id, target_locale: targetLocale },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-article-translations'] });
      toast.success('Translation generated (status: review)');
    },
    onError: (err: any) => toast.error(err.message || 'Translation failed'),
  });

  if (!isNew && isLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  }

  const missingLocales = LOCALES.filter(l => l !== form.locale && !translations.some((t: any) => t.locale === l));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={() => navigate('/app/admin/blog')}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back
        </Button>
        <h1 className="text-2xl font-bold flex-1">{isNew ? 'New Article' : 'Edit Article'}</h1>
        <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="review">Review</SelectItem>
            <SelectItem value="published">Published</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          <Save className="h-4 w-4 mr-2" /> {saveMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main editor */}
        <div className="lg:col-span-2 space-y-4">
          <div>
            <Label>Title</Label>
            <Input value={form.title} onChange={e => {
              const title = e.target.value;
              setForm(f => ({ ...f, title, slug: isNew ? slugify(title) : f.slug }));
            }} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Slug</Label>
              <Input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} />
            </div>
            <div>
              <Label>Locale</Label>
              <Select value={form.locale} onValueChange={v => setForm(f => ({ ...f, locale: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LOCALES.map(l => <SelectItem key={l} value={l}>{l.toUpperCase()}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Excerpt</Label>
            <Textarea value={form.excerpt} onChange={e => setForm(f => ({ ...f, excerpt: e.target.value }))} rows={2} />
          </div>

          <Tabs defaultValue="markdown">
            <TabsList>
              <TabsTrigger value="markdown">Markdown</TabsTrigger>
              <TabsTrigger value="html">HTML</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="markdown">
              <Textarea value={form.body_md} onChange={e => setForm(f => ({ ...f, body_md: e.target.value }))} rows={20} className="font-mono text-sm" placeholder="Write in Markdown..." />
            </TabsContent>
            <TabsContent value="html">
              <Textarea value={form.body_html} onChange={e => setForm(f => ({ ...f, body_html: e.target.value }))} rows={20} className="font-mono text-sm" placeholder="<p>HTML content...</p>" />
            </TabsContent>
            <TabsContent value="preview">
              <div className="prose prose-lg max-w-none dark:prose-invert p-4 border rounded-lg min-h-[300px]" dangerouslySetInnerHTML={{ __html: form.body_html || '<p class="text-muted-foreground">No HTML content yet</p>' }} />
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Cover Image Card */}
          <CoverImageCard
            articleId={isNew ? undefined : id}
            canonicalId={form.canonical_id}
            coverImageUrl={form.cover_image_url}
            coverImageGeneratedAt={article?.cover_image_generated_at}
            isNew={isNew}
            onImageGenerated={() => {
              queryClient.invalidateQueries({ queryKey: ['admin-article', id] });
            }}
          />

          <Card>
            <CardHeader><CardTitle className="text-sm">Meta</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>Tags (comma separated)</Label>
                <Input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} placeholder="padel, tips, training" />
              </div>
              <div>
                <Label>Primary Keyword</Label>
                <Input value={form.primary_keyword} onChange={e => setForm(f => ({ ...f, primary_keyword: e.target.value }))} />
              </div>
              <div>
                <Label>Meta Title</Label>
                <Input value={form.meta_title} onChange={e => setForm(f => ({ ...f, meta_title: e.target.value }))} />
              </div>
              <div>
                <Label>Meta Description</Label>
                <Textarea value={form.meta_description} onChange={e => setForm(f => ({ ...f, meta_description: e.target.value }))} rows={2} />
              </div>
              <div>
                <Label>Cover Image URL</Label>
                <Input value={form.cover_image_url} onChange={e => setForm(f => ({ ...f, cover_image_url: e.target.value }))} />
              </div>
              <div>
                <Label>Author</Label>
                <Input value={form.author_name} onChange={e => setForm(f => ({ ...f, author_name: e.target.value }))} />
              </div>
            </CardContent>
          </Card>

          {!isNew && (
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Globe className="h-4 w-4" /> Translations</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {translations.map((tr: any) => (
                  <div key={tr.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{tr.locale?.toUpperCase()}</Badge>
                      <span className="text-sm truncate max-w-[120px]">{tr.title}</span>
                    </div>
                    <Badge variant={tr.status === 'published' ? 'default' : 'secondary'}>{tr.status}</Badge>
                  </div>
                ))}
                {missingLocales.length > 0 && (
                  <div className="pt-2 border-t space-y-1">
                    <p className="text-xs text-muted-foreground">Generate translation:</p>
                    <div className="flex flex-wrap gap-1">
                      {missingLocales.map(l => (
                        <Button key={l} variant="outline" size="sm" onClick={() => translateMutation.mutate(l)} disabled={translateMutation.isPending}>
                          {l.toUpperCase()}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function CoverImageCard({
  articleId,
  canonicalId,
  coverImageUrl,
  coverImageGeneratedAt,
  isNew,
  onImageGenerated,
}: {
  articleId?: string;
  canonicalId: string;
  coverImageUrl: string;
  coverImageGeneratedAt?: string | null;
  isNew: boolean;
  onImageGenerated: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);

  const generateCover = async (force?: boolean) => {
    if (!articleId) return;
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-blog-cover', {
        body: { article_id: articleId, force: true },
      });
      if (error) throw error;
      const result = data?.results?.[0];
      if (result?.error) throw new Error(result.error);
      toast.success('Cover image generated');
      onImageGenerated();
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate cover image');
    } finally {
      setGenerating(false);
    }
  };

  const generateAllLocales = async () => {
    setGeneratingAll(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-blog-cover', {
        body: { canonical_id: canonicalId, all_locales: true, force: true },
      });
      if (error) throw error;
      const successes = data?.results?.filter((r: any) => r.success)?.length || 0;
      toast.success(`Generated ${successes} cover image(s)`);
      onImageGenerated();
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate cover images');
    } finally {
      setGeneratingAll(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2"><ImageIcon className="h-4 w-4" /> Cover Image</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {coverImageUrl ? (
          <div className="aspect-[1200/630] bg-muted rounded-lg overflow-hidden">
            <img src={coverImageUrl} alt="Cover" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="aspect-[1200/630] bg-muted rounded-lg flex items-center justify-center text-muted-foreground text-sm">
            No cover image
          </div>
        )}

        {coverImageGeneratedAt && (
          <p className="text-xs text-muted-foreground">
            Generated: {new Date(coverImageGeneratedAt).toLocaleString()}
          </p>
        )}

        {!isNew && (
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => generateCover()}
              disabled={generating || generatingAll}
              className="w-full"
            >
              {generating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ImageIcon className="h-4 w-4 mr-2" />}
              {coverImageUrl ? 'Regenerate Cover' : 'Generate Cover'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={generateAllLocales}
              disabled={generating || generatingAll}
              className="w-full"
            >
              {generatingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Generate for All Locales
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
