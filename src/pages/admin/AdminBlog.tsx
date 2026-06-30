import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { ExternalLink, Eye, Pencil } from 'lucide-react';
import { sanityClient, SANITY_STUDIO_URL } from '@/lib/sanity';
import { formatDate } from '@/lib/format';
import { useState } from 'react';

interface SanityPost {
  _id: string;
  title: string;
  slug: string;
  category: string | null;
  datePublished: string | null;
  _updatedAt: string;
}

const ADMIN_POSTS_QUERY = `*[_type == "blogPost"] | order(_updatedAt desc) {
  _id, title, "slug": slug.current, category, datePublished, _updatedAt
}`;

// Sanity rows key on `_id`; the shared DataTable keys on `id`, so callers map `id: _id` into the rows.
type BlogRow = SanityPost & { id: string };

const columns: ColumnDef<BlogRow>[] = [
  { key: 'title', header: 'Title', className: 'font-medium max-w-xs truncate', renderCell: (article) => article.title },
  { key: 'category', header: 'Category', renderCell: (article) => <Badge variant="outline">{article.category || '—'}</Badge> },
  {
    key: 'published',
    header: 'Published',
    className: 'text-sm text-muted-foreground',
    renderCell: (article) => (article.datePublished ? formatDate(article.datePublished) : '—'),
  },
  { key: 'updated', header: 'Updated', className: 'text-sm text-muted-foreground', renderCell: (article) => formatDate(article._updatedAt) },
  {
    key: 'actions',
    header: 'Actions',
    renderCell: (article) => (
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" aria-label="Edit" asChild>
          <a href={`${SANITY_STUDIO_URL}/structure/blogPost;${article._id}`} target="_blank" rel="noopener noreferrer">
            <Pencil className="h-4 w-4" />
          </a>
        </Button>
        {article.datePublished && (
          <Button variant="ghost" size="icon" aria-label="View" asChild>
            <a href={`/en/blog/${article.slug}`} target="_blank" rel="noopener noreferrer">
              <Eye className="h-4 w-4" />
            </a>
          </Button>
        )}
      </div>
    ),
  },
];

export default function AdminBlog() {
  const [search, setSearch] = useState('');

  const { data: articles = [], isLoading } = useQuery({
    queryKey: ['admin-articles-sanity'],
    queryFn: () => sanityClient.fetch<SanityPost[]>(ADMIN_POSTS_QUERY),
  });

  const filtered = articles.filter((a) =>
    !search || a.title?.toLowerCase().includes(search.toLowerCase()) || a.slug?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Blog Articles</h1>
        <Button asChild aria-label="Open Sanity Studio">
          <a href={SANITY_STUDIO_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-4 w-4 mr-2" /> Open Sanity Studio
          </a>
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap">
        <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="max-w-xs" />
      </div>

      <DataTable<BlogRow>
        columns={columns}
        rows={filtered.map((a) => ({ ...a, id: a._id }))}
        desktopOnly={false}
        empty={isLoading ? 'Loading...' : 'No articles found'}
      />
    </div>
  );
}
