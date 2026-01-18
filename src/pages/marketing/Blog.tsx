import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowRight, FileText } from 'lucide-react';
import { getBlogPosts } from '@/lib/contentful';

function BlogPostCardSkeleton() {
  return (
    <Card className="h-full">
      <Skeleton className="aspect-video w-full" />
      <CardContent className="p-6">
        <Skeleton className="h-5 w-20 mb-3" />
        <Skeleton className="h-6 w-full mb-2" />
        <Skeleton className="h-4 w-full mb-4" />
        <Skeleton className="h-4 w-32" />
      </CardContent>
    </Card>
  );
}

function FeaturedPostSkeleton() {
  return (
    <Card className="overflow-hidden border-2">
      <div className="grid md:grid-cols-2">
        <Skeleton className="aspect-video md:aspect-auto md:h-full" />
        <CardContent className="p-8 flex flex-col justify-center">
          <Skeleton className="h-5 w-24 mb-4" />
          <Skeleton className="h-8 w-full mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4 mb-4" />
          <Skeleton className="h-4 w-40" />
        </CardContent>
      </div>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-muted mb-4">
        <FileText className="h-8 w-8 text-muted-foreground" />
      </div>
      <h2 className="text-xl font-semibold mb-2">No articles yet</h2>
      <p className="text-muted-foreground max-w-md mx-auto">
        We're working on creating amazing content for you. Check back soon for tips, insights, and stories from the padel community.
      </p>
    </div>
  );
}

export default function Blog() {
  const { data: posts = [], isLoading } = useQuery({
    queryKey: ['blog-posts'],
    queryFn: getBlogPosts,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  const featuredPost = posts[0];
  const recentPosts = posts.slice(1);

  return (
    <MarketingLayout>
      {/* Hero */}
      <section className="py-16 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center max-w-3xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-4">Blog</h1>
            <p className="text-xl text-muted-foreground">
              Tips, insights, and stories from the Dutch padel community
            </p>
          </motion.div>
        </div>
      </section>

      {/* Content */}
      {isLoading ? (
        <>
          {/* Featured Post Skeleton */}
          <section className="py-12">
            <div className="container mx-auto px-4">
              <FeaturedPostSkeleton />
            </div>
          </section>

          {/* Recent Posts Skeleton */}
          <section className="py-12">
            <div className="container mx-auto px-4">
              <Skeleton className="h-8 w-48 mb-8" />
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[1, 2, 3].map((i) => (
                  <BlogPostCardSkeleton key={i} />
                ))}
              </div>
            </div>
          </section>
        </>
      ) : posts.length === 0 ? (
        <section className="py-12">
          <div className="container mx-auto px-4">
            <EmptyState />
          </div>
        </section>
      ) : (
        <>
          {/* Featured Post */}
          <section className="py-12">
            <div className="container mx-auto px-4">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
              >
                <Link to={`/blog/${featuredPost.slug}`}>
                  <Card className="overflow-hidden hover:shadow-lg transition-shadow border-2 hover:border-primary/20">
                    <div className="grid md:grid-cols-2">
                      <div className="aspect-video md:aspect-auto bg-muted">
                        <img 
                          src={featuredPost.image} 
                          alt={featuredPost.title}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <CardContent className="p-8 flex flex-col justify-center">
                        <Badge className="w-fit mb-4">{featuredPost.category}</Badge>
                        <CardTitle className="text-2xl md:text-3xl mb-4 hover:text-primary transition-colors">
                          {featuredPost.title}
                        </CardTitle>
                        <CardDescription className="text-base mb-4">
                          {featuredPost.excerpt}
                        </CardDescription>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-4 w-4" />
                            {new Date(featuredPost.date).toLocaleDateString('en-US', { 
                              month: 'short', 
                              day: 'numeric',
                              year: 'numeric'
                            })}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-4 w-4" />
                            {featuredPost.readTime}
                          </span>
                        </div>
                      </CardContent>
                    </div>
                  </Card>
                </Link>
              </motion.div>
            </div>
          </section>

          {/* Recent Posts Grid */}
          {recentPosts.length > 0 && (
            <section className="py-12">
              <div className="container mx-auto px-4">
                <h2 className="text-2xl font-bold mb-8">Recent Articles</h2>
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {recentPosts.map((post, index) => (
                    <motion.div
                      key={post.slug}
                      initial={{ opacity: 0, y: 20 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ delay: index * 0.1 }}
                    >
                      <Link to={`/blog/${post.slug}`}>
                        <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                          <div className="aspect-video bg-muted">
                            <img 
                              src={post.image} 
                              alt={post.title}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <CardContent className="p-6">
                            <Badge variant="secondary" className="mb-3">{post.category}</Badge>
                            <CardTitle className="text-lg mb-2 hover:text-primary transition-colors line-clamp-2">
                              {post.title}
                            </CardTitle>
                            <CardDescription className="line-clamp-2 mb-4">
                              {post.excerpt}
                            </CardDescription>
                            <div className="flex items-center gap-4 text-sm text-muted-foreground">
                              <span>{new Date(post.date).toLocaleDateString('en-US', { 
                                month: 'short', 
                                day: 'numeric'
                              })}</span>
                              <span>{post.readTime}</span>
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    </motion.div>
                  ))}
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {/* Newsletter CTA */}
      <section className="py-16 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center max-w-xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-2xl font-bold mb-4">Stay in the loop</h2>
            <p className="text-muted-foreground mb-6">
              Get the latest padel tips and platform updates delivered to your inbox.
            </p>
            <div className="flex gap-3 max-w-md mx-auto">
              <input
                type="email"
                placeholder="Enter your email"
                className="flex-1 px-4 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button className="px-6 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
                Subscribe
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
