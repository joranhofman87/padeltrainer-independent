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
    saving: t('common.save'),
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
    replyToEmail: t('invoiceSettings.replyToEmail', 'Reply-to email for invoices'),
    replyToEmailDescription: t('invoiceSettings.replyToEmailDescription', 'When a player replies to an invoice email, the reply will be sent to this address. If left empty, the academy contact email is used.'),
    replyToEmailPlaceholder: 'info@academy.com',
    invoiceLanguage: t('invoiceSettings.invoiceLanguage', 'Default invoice language'),
    invoiceLanguageDescription: t('invoiceSettings.invoiceLanguageDescription', 'Used for invoice emails and the public payment page. Players with a language preference on their account get invoices in their own language.'),
    forwardEmails: t('invoiceSettings.forwardEmails'),
    forwardEmailsDescription: t('invoiceSettings.forwardEmailsDescription'),
    bulkVatLabel: 'BTW bijwerken op openstaande facturen',
    bulkVatSuccess: 'Openstaande facturen bijgewerkt',
    bulkVatFailed: 'Openstaande facturen konden niet worden bijgewerkt',
    bulkVatAutoSuccess: 'Openstaande facturen bijgewerkt met nieuw BTW-tarief',
    renumberTitle: 'Facturen hernummeren?',
    renumberDescription: 'De factuurnummering is gewijzigd. Selecteer welke facturen hernummerd moeten worden. Betaalde facturen blijven altijd ongewijzigd.',
    renumberDraft: 'Concepten (draft)',
    renumberSent: 'Verzonden (sent)',
    renumberOverdue: 'Achterstallig (overdue)',
    renumberConfirm: 'Hernummeren',
    renumberCancel: 'Annuleren',
    renumberSuccess: (count) => `${count} facturen hernummerd`,
    renumberNothing: 'Geen facturen gevonden om te hernummeren',
    renumberError: 'Hernummeren mislukt',
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
