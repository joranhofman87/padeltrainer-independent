import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { Handshake, Send, Loader2 } from 'lucide-react';
import MarketingLayout from '@/components/marketing/MarketingLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';

const partnerFormSchema = z.object({
  name: z.string().min(2, { message: 'Name must be at least 2 characters' }).max(100),
  companyName: z.string().min(2, { message: 'Company name must be at least 2 characters' }).max(100),
  email: z.string().email({ message: 'Please enter a valid email address' }).max(255),
  phone: z.string().min(6, { message: 'Please enter a valid phone number' }).max(20),
  message: z.string().min(10, { message: 'Message must be at least 10 characters' }).max(2000),
  honeypot: z.string().max(0), // Honeypot field - must be empty
});

type PartnerFormData = z.infer<typeof partnerFormSchema>;

export default function Partner() {
  const { t } = useTranslation('marketing');
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const form = useForm<PartnerFormData>({
    resolver: zodResolver(partnerFormSchema),
    defaultValues: {
      name: '',
      companyName: '',
      email: '',
      phone: '',
      message: '',
      honeypot: '',
    },
  });

  const onSubmit = async (data: PartnerFormData) => {
    // If honeypot is filled, silently "succeed" (it's a bot)
    if (data.honeypot) {
      setIsSubmitted(true);
      return;
    }

    setIsSubmitting(true);

    try {
      // Use direct fetch without auth for public contact form
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-email`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            type: 'partner_inquiry',
            to: 'info@padeltrainer.ai',
            data: {
              name: data.name,
              companyName: data.companyName,
              email: data.email,
              phone: data.phone,
              message: data.message,
            },
          }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      setIsSubmitted(true);
      toast({
        title: t('partner.successTitle'),
        description: t('partner.successMessage'),
      });
    } catch (error) {
      console.error('Error sending partner inquiry:', error);
      toast({
        title: t('partner.errorTitle'),
        description: t('partner.errorMessage'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <MarketingLayout>
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="max-w-2xl mx-auto"
          >
            {/* Header */}
            <div className="text-center mb-12">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-6">
                <Handshake className="h-8 w-8 text-primary" />
              </div>
              <h1 className="text-3xl md:text-4xl font-bold mb-4">
                {t('partner.title')}
              </h1>
              <p className="text-lg text-muted-foreground">
                {t('partner.subtitle')}
              </p>
            </div>

            {isSubmitted ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-center py-12 px-6 bg-muted rounded-lg"
              >
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-6">
                  <Send className="h-8 w-8 text-primary" />
                </div>
                <h2 className="text-2xl font-semibold mb-4">
                  {t('partner.thankYouTitle')}
                </h2>
                <p className="text-muted-foreground">
                  {t('partner.thankYouMessage')}
                </p>
              </motion.div>
            ) : (
              <div className="bg-card border rounded-lg p-6 md:p-8 shadow-sm">
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    {/* Honeypot field - hidden from real users */}
                    <div className="absolute -left-[9999px]" aria-hidden="true">
                      <FormField
                        control={form.control}
                        name="honeypot"
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                {...field}
                                tabIndex={-1}
                                autoComplete="off"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="grid md:grid-cols-2 gap-6">
                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('partner.form.name')}</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={t('partner.form.namePlaceholder')}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="companyName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('partner.form.companyName')}</FormLabel>
                            <FormControl>
                              <Input
                                placeholder={t('partner.form.companyNamePlaceholder')}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="grid md:grid-cols-2 gap-6">
                      <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('partner.form.email')}</FormLabel>
                            <FormControl>
                              <Input
                                type="email"
                                placeholder={t('partner.form.emailPlaceholder')}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="phone"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t('partner.form.phone')}</FormLabel>
                            <FormControl>
                              <Input
                                type="tel"
                                placeholder={t('partner.form.phonePlaceholder')}
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={form.control}
                      name="message"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('partner.form.message')}</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder={t('partner.form.messagePlaceholder')}
                              rows={5}
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <Button
                      type="submit"
                      className="w-full"
                      size="lg"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t('partner.form.sending')}
                        </>
                      ) : (
                        <>
                          <Send className="mr-2 h-4 w-4" />
                          {t('partner.form.submit')}
                        </>
                      )}
                    </Button>
                  </form>
                </Form>
              </div>
            )}
          </motion.div>
        </div>
      </section>
    </MarketingLayout>
  );
}
