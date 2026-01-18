import { useParams, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowLeft, Share2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getPostBySlug, urlFor } from '@/lib/sanity';
import { PortableText } from '@portabletext/react';
import { useTranslation } from 'react-i18next';

// Fallback content for the demo article
const fallbackPost = {
  _id: 'fallback-1',
  title: 'How to Choose the Right Padel Trainer for Your Level',
  excerpt: 'Finding the perfect trainer can accelerate your progress dramatically.',
  slug: 'how-to-choose-padel-trainer',
  category: 'Tips & Advice',
  publishedAt: '2025-01-10',
  readTime: '5 min read',
  htmlContent: `
    <p>Choosing the right padel trainer is one of the most important decisions you'll make on your journey to improving your game. The right trainer can accelerate your progress dramatically, while the wrong fit might leave you frustrated and stuck at the same level.</p>

    <h2>Know Your Current Level</h2>
    <p>Before you start looking for a trainer, honestly assess where you are in your padel journey. Are you a complete beginner who needs to learn the basics? An intermediate player looking to refine specific shots? Or an advanced player preparing for competition?</p>

    <h2>Look for KNLTB Certification</h2>
    <p>In the Netherlands, the KNLTB (Royal Dutch Tennis Association) provides official certifications for padel trainers. Look for trainers who have completed their certification, as this ensures they have the foundational knowledge to teach effectively.</p>

    <h2>Read Reviews and Ratings</h2>
    <p>One of the best ways to gauge a trainer's effectiveness is through reviews from other players. On PadelTrainer.ai, every trainer has verified reviews from actual students. Pay attention to reviews from players at a similar level to you.</p>

    <h2>Consider Specializations</h2>
    <p>Some trainers specialize in specific areas: beginners, competitive play, specific techniques like the bandeja or víbora, or even mental game coaching. If you have specific goals, look for a trainer whose expertise aligns with those goals.</p>

    <h2>Book a Trial Lesson</h2>
    <p>Many trainers offer trial lessons at a reduced rate. This is an excellent way to see if you click with the trainer's teaching style before committing to multiple sessions.</p>

    <h2>Communication Matters</h2>
    <p>A good trainer should be able to explain concepts clearly and adapt their teaching style to your learning preferences. If you don't understand something, they should be patient and willing to try different approaches.</p>

    <h2>Check Availability and Location</h2>
    <p>Practical factors matter too. Can the trainer accommodate your schedule? Is the training location convenient for you? Consistency is key to improvement, so choose a trainer you can train with regularly.</p>
  `,
};

// Custom components for rendering Portable Text
const portableTextComponents = {
  block: {
    h2: ({ children }: { children?: React.ReactNode }) => (
      <h2 className="text-2xl font-bold mt-8 mb-4 text-foreground">{children}</h2>
    ),
    h3: ({ children }: { children?: React.ReactNode }) => (
      <h3 className="text-xl font-bold mt-6 mb-3 text-foreground">{children}</h3>
    ),
    normal: ({ children }: { children?: React.ReactNode }) => (
      <p className="text-muted-foreground mb-4 leading-relaxed">{children}</p>
    ),
  },
  marks: {
    link: ({ children, value }: { children?: React.ReactNode; value?: { href?: string } }) => (
      <a 
        href={value?.href} 
        className="text-primary hover:underline"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
    strong: ({ children }: { children?: React.ReactNode }) => (
      <strong className="font-bold">{children}</strong>
    ),
  },
};

function ArticleSkeleton() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <Skeleton className="h-6 w-24 mb-4" />
      <Skeleton className="h-10 w-full mb-4" />
      <Skeleton className="h-10 w-3/4 mb-4" />
      <div className="flex gap-4 mb-8">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="aspect-video w-full mb-8" />
      <div className="space-y-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-8 w-1/3 mt-6" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  );
}

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const { t } = useTranslation('marketing');

  const { data: post, isLoading, error } = useQuery({
    queryKey: ['sanity-post', slug],
    queryFn: () => getPostBySlug(slug || ''),
    enabled: !!slug,
    staleTime: 1000 * 60 * 5,
  });

  // Use Sanity post if available, otherwise check for fallback
  const displayPost = post || (slug === 'how-to-choose-padel-trainer' ? fallbackPost : null);

  if (isLoading) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 pt-8">
          <Skeleton className="h-10 w-32" />
        </div>
        <ArticleSkeleton />
      </MarketingLayout>
    );
  }

  if (error || !displayPost) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">{t('blog.notFound.title')}</h1>
          <p className="text-muted-foreground mb-6">
            {t('blog.notFound.description')}
          </p>
          <Button asChild>
            <Link to="/blog">{t('blog.notFound.backButton')}</Link>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  const imageUrl = 'mainImage' in displayPost && displayPost.mainImage 
    ? urlFor(displayPost.mainImage).width(1200).url() 
    : '/placeholder.svg';

  return (
    <MarketingLayout>
      {/* Back Button */}
      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <Link to="/blog" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" />
            {t('blog.backToList')}
          </Link>
        </Button>
      </div>

      {/* Article Header */}
      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Badge className="mb-4">{displayPost.category}</Badge>
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{displayPost.title}</h1>
          <div className="flex items-center gap-4 text-muted-foreground mb-8">
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              {new Date(displayPost.publishedAt).toLocaleDateString('en-US', { 
                month: 'long', 
                day: 'numeric',
                year: 'numeric'
              })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {displayPost.readTime}
            </span>
            <Button variant="ghost" size="sm">
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </Button>
          </div>
        </motion.div>

        {/* Featured Image */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="aspect-video bg-muted rounded-xl overflow-hidden mb-8"
        >
          <img 
            src={imageUrl} 
            alt={displayPost.title}
            className="w-full h-full object-cover"
          />
        </motion.div>

        {/* Article Content */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="prose prose-lg max-w-none"
        >
          {'content' in displayPost && displayPost.content ? (
            <PortableText 
              value={displayPost.content} 
              components={portableTextComponents}
            />
          ) : 'htmlContent' in displayPost && displayPost.htmlContent ? (
            <div 
              className="prose prose-lg max-w-none
                prose-headings:font-bold prose-headings:text-foreground
                prose-p:text-muted-foreground
                prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                prose-h2:text-2xl prose-h2:mt-8 prose-h2:mb-4"
              dangerouslySetInnerHTML={{ __html: displayPost.htmlContent }}
            />
          ) : (
            <p className="text-muted-foreground">No content available.</p>
          )}
        </motion.div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-12 p-8 bg-accent/30 rounded-xl text-center"
        >
          <h3 className="text-xl font-bold mb-2">{t('blog.cta.title')}</h3>
          <p className="text-muted-foreground mb-4">
            {t('blog.cta.description')}
          </p>
          <Button asChild>
            <Link to="/trainers">{t('blog.cta.button')}</Link>
          </Button>
        </motion.div>
      </article>
    </MarketingLayout>
  );
}
