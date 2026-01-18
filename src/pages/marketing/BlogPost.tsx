import { useParams, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowLeft, Share2 } from 'lucide-react';

// Mock blog post data - in a real app this would come from a CMS
const blogPostsData: Record<string, {
  title: string;
  excerpt: string;
  content: string;
  category: string;
  date: string;
  readTime: string;
  image: string;
}> = {
  'how-to-choose-padel-trainer': {
    title: 'How to Choose the Right Padel Trainer for Your Level',
    excerpt: 'Finding the perfect trainer can accelerate your progress dramatically.',
    content: `
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
    category: 'Tips & Advice',
    date: '2025-01-10',
    readTime: '5 min read',
    image: '/placeholder.svg'
  }
};

export default function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? blogPostsData[slug] : null;

  if (!post) {
    return (
      <MarketingLayout>
        <div className="container mx-auto px-4 py-20 text-center">
          <h1 className="text-2xl font-bold mb-4">Article not found</h1>
          <p className="text-muted-foreground mb-6">
            The article you're looking for doesn't exist or has been moved.
          </p>
          <Button asChild>
            <Link to="/blog">Back to Blog</Link>
          </Button>
        </div>
      </MarketingLayout>
    );
  }

  return (
    <MarketingLayout>
      {/* Back Button */}
      <div className="container mx-auto px-4 pt-8">
        <Button variant="ghost" asChild>
          <Link to="/blog" className="flex items-center gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Blog
          </Link>
        </Button>
      </div>

      {/* Article Header */}
      <article className="container mx-auto px-4 py-8 max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Badge className="mb-4">{post.category}</Badge>
          <h1 className="text-3xl md:text-4xl font-bold mb-4">{post.title}</h1>
          <div className="flex items-center gap-4 text-muted-foreground mb-8">
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              {new Date(post.date).toLocaleDateString('en-US', { 
                month: 'long', 
                day: 'numeric',
                year: 'numeric'
              })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {post.readTime}
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
            src={post.image} 
            alt={post.title}
            className="w-full h-full object-cover"
          />
        </motion.div>

        {/* Article Content */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="prose prose-lg max-w-none
            prose-headings:font-bold prose-headings:text-foreground
            prose-p:text-muted-foreground
            prose-a:text-primary prose-a:no-underline hover:prose-a:underline
            prose-h2:text-2xl prose-h2:mt-8 prose-h2:mb-4"
          dangerouslySetInnerHTML={{ __html: post.content }}
        />

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-12 p-8 bg-accent/30 rounded-xl text-center"
        >
          <h3 className="text-xl font-bold mb-2">Ready to find your perfect trainer?</h3>
          <p className="text-muted-foreground mb-4">
            Browse verified trainers matched to your skill level.
          </p>
          <Button asChild>
            <Link to="/trainers">Find Trainers</Link>
          </Button>
        </motion.div>
      </article>
    </MarketingLayout>
  );
}
