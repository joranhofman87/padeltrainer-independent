import { useTranslation } from 'react-i18next';
import { InvoiceSettingsCardBase, type InvoiceSettingsLabels } from '@/components/invoices/InvoiceSettingsCardBase';

interface AcademyInvoiceSettingsCardProps {
  academyId: string;
}

export function AcademyInvoiceSettingsCard({ academyId }: AcademyInvoiceSettingsCardProps) {
  const { t } = useTranslation('academy');

  const labels: InvoiceSettingsLabels = {
    title: t('invoiceSettings.title'),
    description: t('invoiceSettings.description'),
    complete: t('invoiceSettings.complete'),
    saved: t('invoiceSettings.saved'),
    saveError: t('common.error'),
    saving: t('invoiceSettings.saving', 'Saving…'),
    save: t('common.save'),
    logo: t('invoiceSettings.logo'),
    logoDescription: t('invoiceSettings.logoDescription'),
    noLogo: t('invoiceSettings.noLogo'),
    uploadLogo: t('invoiceSettings.uploadLogo'),
    bannerColor: t('invoiceSettings.bannerColor'),
    bannerColorDescription: t('invoiceSettings.bannerColorDescription'),
    noColor: t('invoiceSettings.noColor'),
    customColor: t('invoiceSettings.customColor'),
    businessName: t('invoiceSettings.businessName'),
    businessNamePlaceholder: 'Academy B.V.',
    kvkNumber: t('invoiceSettings.kvkNumber'),
    businessAddress: t('invoiceSettings.businessAddress'),
    btwNumber: t('invoiceSettings.btwNumber'),
    paymentTerms: t('invoiceSettings.paymentTerms'),
    days7: t('invoiceSettings.days7'),
    days14: t('invoiceSettings.days14'),
    days30: t('invoiceSettings.days30'),
    defaultVatRate: t('invoiceSettings.defaultVatRate'),
    vatStandard: t('invoiceSettings.vatStandard'),
    vatReduced: t('invoiceSettings.vatReduced'),
    vatExempt: t('invoiceSettings.vatExempt'),
    vatCustom: t('invoiceSettings.vatCustom'),
    customVatRate: t('invoiceSettings.customVatRate'),
    numbering: t('invoiceSettings.numbering'),
    prefix: t('invoiceSettings.prefix'),
    nextNumber: t('invoiceSettings.nextNumber'),
    includeYear: t('invoiceSettings.includeYear', 'Jaar opnemen in factuurnummer'),
    previewNumber: t('invoiceSettings.previewNumber'),
    replyToEmail: t('invoiceSettings.replyToEmail', 'Invoice reply-to email'),
    replyToEmailDescription: t(
      'invoiceSettings.replyToEmailDescription',
      'Used as the public contact email on invoice payment pages and as the reply-to for invoice emails.',
    ),
    replyToEmailPlaceholder: 'info@academy.com',
    invoiceLanguage: t('invoiceSettings.invoiceLanguage', 'Default invoice language'),
    invoiceLanguageDescription: t('invoiceSettings.invoiceLanguageDescription', 'Used for invoice emails and the public payment page. Players with a language preference on their account get invoices in their own language.'),
    forwardEmails: t('invoiceSettings.forwardEmails'),
    forwardEmailsDescription: t('invoiceSettings.forwardEmailsDescription'),
    bulkVatLabel: t('invoiceSettings.bulkVatLabel', 'BTW bijwerken op openstaande facturen'),
    bulkVatSuccess: t('invoiceSettings.bulkVatSuccess', 'Openstaande facturen bijgewerkt'),
    bulkVatFailed: t('invoiceSettings.bulkVatFailed', 'Openstaande facturen konden niet worden bijgewerkt'),
    bulkVatAutoSuccess: t('invoiceSettings.bulkVatAutoSuccess', 'Openstaande facturen bijgewerkt met nieuw BTW-tarief'),
    renumberTitle: t('invoiceSettings.renumberTitle', 'Conceptfacturen hernummeren?'),
    renumberDescription: t('invoiceSettings.renumberDescription', 'De factuurnummering is gewijzigd. Conceptfacturen krijgen automatisch een nieuw nummer. Verzonden en betaalde facturen behouden hun nummer.'),
    renumberConfirm: t('invoiceSettings.renumberConfirm', 'Hernummeren'),
    renumberCancel: t('invoiceSettings.renumberCancel', 'Annuleren'),
    renumberSuccess: (count) => t('invoiceSettings.renumberSuccess', '{{count}} facturen hernummerd', { count }),
    renumberPartial: (updated, failed) =>
      t('invoiceSettings.renumberPartial', '{{updated}} facturen hernummerd, {{failed}} mislukt', { updated, failed }),
    renumberNothing: t('invoiceSettings.renumberNothing', 'Geen conceptfacturen gevonden om te hernummeren'),
    renumberError: t('invoiceSettings.renumberError', 'Hernummeren mislukt'),
  };

  return (
    <InvoiceSettingsCardBase
      ownerId={academyId}
      table="academy_profiles"
      ownerColumn="id"
      ownerType="academy"
      buildLogoPath={(ext) => `academies/${academyId}/invoice-logo.${ext}`}
      labels={labels}
      idPrefix="ac"
      enableBulkVat
      bulkVatPayloadId={academyId}
    />
  );
}
