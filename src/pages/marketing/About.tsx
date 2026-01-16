import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';
import { Target, Heart, Users, Zap } from 'lucide-react';

export default function About() {
  const values = [
    {
      icon: Target,
      title: 'Quality First',
      description: 'We verify every trainer to ensure players get the best possible experience.'
    },
    {
      icon: Heart,
      title: 'Player Focused',
      description: 'Every feature we build starts with the question: how does this help players improve?'
    },
    {
      icon: Users,
      title: 'Community Driven',
      description: 'We believe in the power of the padel community to help each other grow.'
    },
    {
      icon: Zap,
      title: 'Simplicity',
      description: 'Booking a lesson should be as easy as sending a text message.'
    }
  ];

  return (
    <MarketingLayout>
      {/* Hero */}
      <section className="py-20 bg-gradient-to-b from-background to-accent/20">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center max-w-3xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Making padel training
              <span className="block text-primary">accessible to everyone</span>
            </h1>
            <p className="text-xl text-muted-foreground">
              We're on a mission to connect every padel player in the Netherlands 
              with the perfect trainer to help them improve their game.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Story */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
            >
              <h2 className="text-3xl font-bold mb-6">Our Story</h2>
              <div className="prose prose-lg text-muted-foreground">
                <p>
                  PadelTrainer.ai was born from a simple frustration: finding a good padel 
                  trainer shouldn't be this hard. As padel exploded in popularity across the 
                  Netherlands, we saw players struggling to find quality training, while 
                  talented trainers had no easy way to reach new students.
                </p>
                <p>
                  We set out to build the platform we wished existed. One where players 
                  could easily find verified trainers matched to their skill level, and where 
                  trainers could grow their business without the hassle of managing bookings, 
                  payments, and scheduling.
                </p>
                <p>
                  Today, PadelTrainer.ai connects hundreds of trainers with thousands of 
                  players across the Netherlands. We're proud to be part of the growing 
                  padel community and excited about where we're heading next.
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="py-20 bg-accent/30">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center mb-12"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl font-bold mb-4">Our Values</h2>
            <p className="text-lg text-muted-foreground">
              The principles that guide everything we do
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
            {values.map((value, index) => (
              <motion.div
                key={value.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="h-full text-center">
                  <CardContent className="p-6">
                    <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                      <value.icon className="h-6 w-6 text-primary" />
                    </div>
                    <h3 className="font-semibold mb-2">{value.title}</h3>
                    <p className="text-sm text-muted-foreground">{value.description}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="py-20">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-8 max-w-3xl mx-auto text-center">
            {[
              { value: '2024', label: 'Founded' },
              { value: '500+', label: 'Trainers' },
              { value: '50+', label: 'Cities' }
            ].map((stat, index) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
              >
                <div className="text-4xl font-bold text-primary mb-2">{stat.value}</div>
                <div className="text-muted-foreground">{stat.label}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-accent text-accent-foreground">
        <div className="container mx-auto px-4">
          <motion.div
            className="text-center max-w-2xl mx-auto"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl font-bold mb-4">Join our community</h2>
            <p className="text-lg text-accent-foreground/80 mb-8">
              Whether you're a player looking to improve or a trainer looking to grow, 
              we'd love to have you.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" className="px-8" asChild>
                <Link to="/auth">Get Started</Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <a href="mailto:hello@padeltrainer.ai">Contact Us</a>
              </Button>
            </div>
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
