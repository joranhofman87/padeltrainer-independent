import { motion } from 'framer-motion';
import { MessageSquare, Table, CalendarX, RefreshCw, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function ChaosPainSection() {
  const { t } = useTranslation('marketing');

  const chaosItems = [
    { icon: MessageSquare, key: 'whatsapp' },
    { icon: Table, key: 'spreadsheet' },
    { icon: CalendarX, key: 'calendar' },
    { icon: RefreshCw, key: 'rescheduling' },
    { icon: Wrench, key: 'generic' },
  ];

  return (
    <section className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-4 md:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-6">
            {t('homev2.chaos.headline')}
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            {t('homev2.chaos.intro')}
          </p>

          <ul className="space-y-4 mb-8">
            {chaosItems.map(item => (
              <li key={item.key} className="flex items-start gap-3">
                <item.icon className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
                <span className="text-foreground">{t(`homev2.chaos.item_${item.key}`)}</span>
              </li>
            ))}
          </ul>

          <p className="text-lg font-medium text-foreground italic">
            {t('homev2.chaos.closing')}
          </p>
        </motion.div>
      </div>
    </section>
  );
}
