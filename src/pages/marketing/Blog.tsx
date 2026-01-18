import { Link } from 'react-router-dom';
import { Card, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getAllPosts, urlFor } from '@/lib/sanity';
import type { SanityPost } from '@/lib/sanity';
import { useTranslation } from 'react-i18next';

// Fallback mock data when Sanity is not configured
const fallbackPosts = [
  {
    _id: '1',
    slug: 'how-to-choose-padel-trainer',
    title: 'How to Choose the Right Padel Trainer for Your Level',
    excerpt: 'Finding the perfect trainer can accelerate your progress dramatically. Here\'s what to look for based on your current skill level.',
    category: 'Tips & Advice',
    publishedAt: '2025-01-10',
    readTime: '5 min read',
  },
  {
    _id: '2',
    slug: 'padel-growth-netherlands-2025',
    title: 'Padel in the Netherlands: 2025 Growth Report',
    excerpt: 'New courts, growing memberships, and an increasingly competitive scene. We break down the state of padel in NL.',
    category: 'Industry',
    publishedAt: '2025-01-05',
    readTime: '8 min read',
  },
  {
    _id: '3',
    slug: 'improve-padel-serve',
    title: '5 Drills to Improve Your Padel Serve',
    excerpt: 'The serve is often overlooked in padel training. These 5 drills will help you add consistency and variety to your game.',
    category: 'Training',
    publishedAt: '2024-12-28',
    readTime: '6 min read',
  },
];

function PostCardSkeleton() {
  return (
    <Card className="h-full">
      <Skeleton className="aspect-video w-full" />
      <CardContent className="p-6">
        <Skeleton className="h-5 w-20 mb-3" />
        <Skeleton className="h-6 w-full mb-2" />
        <Skeleton className="h-4 w-full mb-4" />
        <Skeleton className="h-4 w-3/4" />
      </CardContent>
    </Card>
  );
}

function FeaturedPostSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="grid md:grid-cols-2">
        <Skeleton className="aspect-video md:aspect-auto md:h-full" />
        <CardContent className="p-8 flex flex-col justify-center">
          <Skeleton className="h-5 w-24 mb-4" />
          <Skeleton className="h-8 w-full mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4 mb-4" />
          <Skeleton className="h-4 w-32" />
        </CardContent>
      </div>
    </Card>
  );
}

export default function Blog() {
  const { t } = useTranslation('marketing');
  
  const { data: posts, isLoading, error } = useQuery({
    queryKey: ['sanity-posts'],
    queryFn: getAllPosts,
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
  });

  // Use Sanity posts if available, otherwise fallback to mock data
  const blogPosts: SanityPost[] = (posts && posts.length > 0) ? posts : fallbackPosts as SanityPost[];
  const featuredPost = blogPosts[0];
  const recentPosts = blogPosts.slice(1);

  const getImageUrl = (post: SanityPost) => {
    if (post.mainImage) {
      return urlFor(post.mainImage).width(800).url();
    }
    return '/placeholder.svg';
  };

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
            <h1 className="text-4xl md:text-5xl font-bold mb-4">{t('blog.title')}</h1>
            <p className="text-xl text-muted-foreground">
              {t('blog.subtitle')}
            </p>
          </motion.div>
        </div>
      </section>

      {/* Featured Post */}
      <section className="py-12">
        <div className="container mx-auto px-4">
          {isLoading ? (
            <FeaturedPostSkeleton />
          ) : error ? (
            <div className="text-center text-muted-foreground py-8">
              Failed to load blog posts. Please try again later.
            </div>
          ) : featuredPost ? (
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
                        src={getImageUrl(featuredPost)} 
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
                          {new Date(featuredPost.publishedAt).toLocaleDateString('en-US', { 
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
          ) : null}
        </div>
      </section>

      {/* Recent Posts Grid */}
      <section className="py-12">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl font-bold mb-8">{t('blog.recentArticles')}</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {isLoading ? (
              <>
                <PostCardSkeleton />
                <PostCardSkeleton />
                <PostCardSkeleton />
              </>
            ) : (
              recentPosts.map((post, index) => (
                <motion.div
                  key={post._id}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.1 }}
                >
                  <Link to={`/blog/${post.slug}`}>
                    <Card className="h-full hover:shadow-lg transition-shadow hover:border-primary/20">
                      <div className="aspect-video bg-muted">
                        <img 
                          src={getImageUrl(post)} 
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
                          <span>{new Date(post.publishedAt).toLocaleDateString('en-US', { 
                            month: 'short', 
                            day: 'numeric'
                          })}</span>
                          <span>{post.readTime}</span>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                </motion.div>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Newsletter CTA */}
      <section className="py-16 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center max-w-xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-2xl font-bold mb-4">{t('blog.newsletter.title')}</h2>
            <p className="text-muted-foreground mb-6">
              {t('blog.newsletter.description')}
            </p>
            <div className="flex gap-3 max-w-md mx-auto">
              <input
                type="email"
                placeholder={t('blog.newsletter.placeholder')}
                className="flex-1 px-4 py-2 rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button className="px-6 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
                {t('blog.newsletter.button')}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
