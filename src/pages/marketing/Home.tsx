import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { 
  ArrowRight, 
  Users, 
  Star, 
  MapPin, 
  Calendar,
  Shield,
  TrendingUp,
  CheckCircle2,
  Zap
} from 'lucide-react';

const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5 }
};

const staggerContainer = {
  animate: {
    transition: {
      staggerChildren: 0.1
    }
  }
};

export default function Home() {
  const features = [
    {
      icon: Users,
      title: 'Verified Trainers',
      description: 'Every trainer is verified with their KNLTB credentials and real reviews from players.'
    },
    {
      icon: Calendar,
      title: 'Easy Booking',
      description: 'Book lessons with just a few clicks. Flexible scheduling that fits your life.'
    },
    {
      icon: Star,
      title: 'Skill Matching',
      description: 'Find trainers that specialize in your skill level, from beginner to advanced.'
    },
    {
      icon: MapPin,
      title: 'Local Trainers',
      description: 'Connect with trainers near you across all major cities in the Netherlands.'
    },
    {
      icon: Shield,
      title: 'Secure Payments',
      description: 'Pay securely through our platform with iDEAL and card support.'
    },
    {
      icon: TrendingUp,
      title: 'Track Progress',
      description: 'Monitor your improvement and get insights on your padel journey.'
    }
  ];

  const stats = [
    { value: '500+', label: 'Certified Trainers' },
    { value: '10,000+', label: 'Lessons Booked' },
    { value: '4.9', label: 'Average Rating' },
    { value: '50+', label: 'Cities Covered' }
  ];

  const testimonials = [
    {
      name: 'Thomas de Vries',
      role: 'Player since 2023',
      content: 'Found an amazing trainer in Amsterdam within minutes. My game has improved significantly in just 2 months!',
      rating: 5
    },
    {
      name: 'Lisa van den Berg',
      role: 'KNLTB Level 6',
      content: 'The skill matching is spot-on. My trainer knows exactly how to push me to the next level.',
      rating: 5
    },
    {
      name: 'Mark Jansen',
      role: 'Padel Trainer',
      content: 'As a trainer, PadelTrainer.ai has helped me fill my schedule and connect with motivated players.',
      rating: 5
    }
  ];

  return (
    <MarketingLayout>
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-accent/5" />
        <div className="absolute top-20 right-10 w-72 h-72 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-10 left-10 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
        
        <div className="container relative mx-auto px-4 py-20 md:py-32">
          <motion.div 
            className="text-center max-w-4xl mx-auto"
            initial="initial"
            animate="animate"
            variants={staggerContainer}
          >
            <motion.div variants={fadeInUp}>
              <Badge variant="secondary" className="mb-6 px-4 py-1.5 text-sm">
                <Zap className="h-3.5 w-3.5 mr-1.5" />
                Now live across the Netherlands
              </Badge>
            </motion.div>
            
            <motion.h1 
              variants={fadeInUp}
              className="text-4xl md:text-6xl lg:text-7xl font-bold mb-6 tracking-tight"
            >
              Find Your Perfect
              <span className="block bg-gradient-to-r from-primary to-[hsl(var(--brand-gold))] bg-clip-text text-transparent">
                Padel Trainer
              </span>
            </motion.h1>
            
            <motion.p 
              variants={fadeInUp}
              className="text-xl md:text-2xl text-muted-foreground mb-10 max-w-2xl mx-auto"
            >
              Connect with certified trainers, book lessons that match your skill level, 
              and start improving your game today.
            </motion.p>
            
            <motion.div 
              variants={fadeInUp}
              className="flex flex-col sm:flex-row gap-4 justify-center"
            >
              <Button size="lg" className="text-lg px-8 h-14 bg-primary hover:bg-primary/90" asChild>
                <Link to="/signup/player">
                  Start as Player
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" className="text-lg px-8 h-14 border-2" asChild>
                <Link to="/signup/trainer">Join as Trainer</Link>
              </Button>
            </motion.div>

            {/* Trust indicators */}
            <motion.div 
              variants={fadeInUp}
              className="mt-12 flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>Free to join</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>KNLTB verified</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <span>Secure payments</span>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="border-y bg-accent/30">
        <div className="container mx-auto px-4 py-12">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat, index) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="text-center"
              >
                <div className="text-3xl md:text-4xl font-bold text-primary mb-1">
                  {stat.value}
                </div>
                <div className="text-sm text-muted-foreground">{stat.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center mb-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Everything you need to improve your game
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              From finding the right trainer to booking and paying, we make the entire process seamless.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="h-full hover:shadow-lg transition-shadow border-2 hover:border-primary/20">
                  <CardContent className="p-6">
                    <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                      <feature.icon className="h-6 w-6 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                    <p className="text-muted-foreground">{feature.description}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section className="py-20 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center mb-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">How it works</h2>
            <p className="text-lg text-muted-foreground">Get started in 3 simple steps</p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {[
              { step: '1', title: 'Create your profile', description: 'Sign up and add your KNLTB rating to get personalized trainer recommendations.' },
              { step: '2', title: 'Find your trainer', description: 'Browse verified trainers, read reviews, and find the perfect match for your goals.' },
              { step: '3', title: 'Book & play', description: 'Select a time slot, pay securely, and start improving your padel game.' }
            ].map((item, index) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.15 }}
                className="text-center"
              >
                <div className="h-16 w-16 rounded-full bg-primary text-primary-foreground text-2xl font-bold flex items-center justify-center mx-auto mb-4">
                  {item.step}
                </div>
                <h3 className="text-xl font-semibold mb-2">{item.title}</h3>
                <p className="text-muted-foreground">{item.description}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center mb-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Loved by players & trainers</h2>
            <p className="text-lg text-muted-foreground">See what our community has to say</p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6">
            {testimonials.map((testimonial, index) => (
              <motion.div
                key={testimonial.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="h-full">
                  <CardContent className="p-6">
                    <div className="flex gap-1 mb-4">
                      {Array.from({ length: testimonial.rating }).map((_, i) => (
                        <Star key={i} className="h-4 w-4 fill-primary text-primary" />
                      ))}
                    </div>
                    <p className="text-muted-foreground mb-4">"{testimonial.content}"</p>
                    <div>
                      <div className="font-semibold">{testimonial.name}</div>
                      <div className="text-sm text-muted-foreground">{testimonial.role}</div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-accent text-accent-foreground">
        <div className="container mx-auto px-4">
          <motion.div 
            className="text-center max-w-2xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Ready to level up your padel game?
            </h2>
            <p className="text-lg text-accent-foreground/80 mb-8">
              Join thousands of players who are already improving with PadelTrainer.ai
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" className="text-lg px-8 h-14 bg-primary hover:bg-primary/90" asChild>
                <Link to="/signup/player">
                  Get Started Free
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>
              </Button>
              <Button size="lg" variant="secondary" className="text-lg px-8 h-14" asChild>
                <Link to="/trainers">Browse Trainers</Link>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
