import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Calendar, Clock, ArrowRight } from 'lucide-react';

// Mock blog posts - in a real app these would come from a CMS or database
const blogPosts = [
  {
    slug: 'how-to-choose-padel-trainer',
    title: 'How to Choose the Right Padel Trainer for Your Level',
    excerpt: 'Finding the perfect trainer can accelerate your progress dramatically. Here\'s what to look for based on your current skill level.',
    category: 'Tips & Advice',
    date: '2025-01-10',
    readTime: '5 min read',
    image: '/placeholder.svg'
  },
  {
    slug: 'padel-growth-netherlands-2025',
    title: 'Padel in the Netherlands: 2025 Growth Report',
    excerpt: 'New courts, growing memberships, and an increasingly competitive scene. We break down the state of padel in NL.',
    category: 'Industry',
    date: '2025-01-05',
    readTime: '8 min read',
    image: '/placeholder.svg'
  },
  {
    slug: 'improve-padel-serve',
    title: '5 Drills to Improve Your Padel Serve',
    excerpt: 'The serve is often overlooked in padel training. These 5 drills will help you add consistency and variety to your game.',
    category: 'Training',
    date: '2024-12-28',
    readTime: '6 min read',
    image: '/placeholder.svg'
  },
  {
    slug: 'trainer-spotlight-amsterdam',
    title: 'Trainer Spotlight: Top 5 Trainers in Amsterdam',
    excerpt: 'Meet the most highly-rated padel trainers in Amsterdam and learn what makes them stand out.',
    category: 'Spotlight',
    date: '2024-12-20',
    readTime: '4 min read',
    image: '/placeholder.svg'
  },
  {
    slug: 'padel-equipment-guide',
    title: 'The Complete Padel Equipment Guide for Beginners',
    excerpt: 'From rackets to shoes, everything you need to know before your first lesson.',
    category: 'Guides',
    date: '2024-12-15',
    readTime: '10 min read',
    image: '/placeholder.svg'
  },
  {
    slug: 'mental-game-padel',
    title: 'The Mental Game: How to Stay Focused During Matches',
    excerpt: 'Top trainers share their tips for maintaining focus and confidence when it matters most.',
    category: 'Training',
    date: '2024-12-10',
    readTime: '7 min read',
    image: '/placeholder.svg'
  }
];

export default function Blog() {
  const featuredPost = blogPosts[0];
  const recentPosts = blogPosts.slice(1);

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
