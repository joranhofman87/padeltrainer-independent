import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExternalLink, Eye, Pencil } from 'lucide-react';
import { sanityClient, SANITY_STUDIO_URL } from '@/lib/sanity';
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
        <Button asChild>
          <a href={SANITY_STUDIO_URL} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-4 w-4 mr-2" /> Open Sanity Studio
          </a>
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap">
        <Input placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} className="max-w-xs" />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Published</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={5} className="text-center py-8">Loading...</TableCell></TableRow>
          ) : filtered.length === 0 ? (
            <TableRow><TableCell colSpan={5} className="text-center py-8">No articles found</TableCell></TableRow>
          ) : (
            filtered.map((article) => (
              <TableRow key={article._id}>
                <TableCell className="font-medium max-w-xs truncate">{article.title}</TableCell>
                <TableCell><Badge variant="outline">{article.category || '—'}</Badge></TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {article.datePublished ? new Date(article.datePublished).toLocaleDateString() : '—'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(article._updatedAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" asChild>
                      <a href={`${SANITY_STUDIO_URL}/structure/blogPost;${article._id}`} target="_blank" rel="noopener noreferrer">
                        <Pencil className="h-4 w-4" />
                      </a>
                    </Button>
                    {article.datePublished && (
                      <Button variant="ghost" size="icon" asChild>
                        <a href={`/en/blog/${article.slug}`} target="_blank" rel="noopener noreferrer">
                          <Eye className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
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
