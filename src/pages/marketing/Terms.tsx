import MarketingLayout from '@/components/marketing/MarketingLayout';
import { motion } from 'framer-motion';

export default function Terms() {
  return (
    <MarketingLayout>
      <div className="container mx-auto px-4 py-16 max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-4xl font-bold mb-8">Terms of Service</h1>
          <p className="text-muted-foreground mb-8">
            Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>

          <div className="prose prose-lg max-w-none space-y-8">
            <section>
              <h2 className="text-2xl font-semibold mb-4">1. Agreement to Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                By accessing or using PadelTrainer.ai ("Platform"), you agree to be bound by these Terms of Service ("Terms"). If you disagree with any part of these terms, you may not access the Platform. These Terms apply to all visitors, users, and others who access or use the Platform.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">2. Description of Service</h2>
              <p className="text-muted-foreground leading-relaxed">
                PadelTrainer.ai is an online platform that connects padel players ("Players") with padel trainers ("Trainers"). We provide scheduling, booking, and payment processing tools to facilitate training sessions. PadelTrainer.ai acts as an intermediary and is not a party to the agreements between Players and Trainers.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">3. User Accounts</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                When you create an account with us, you must provide accurate, complete, and current information. You are responsible for:
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>Maintaining the confidentiality of your account and password</li>
                <li>Restricting access to your account</li>
                <li>All activities that occur under your account</li>
                <li>Notifying us immediately of any unauthorized use of your account</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">4. For Players</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                As a Player using our Platform, you agree to:
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>Provide accurate information when booking lessons</li>
                <li>Pay for booked lessons as agreed</li>
                <li>Arrive on time for scheduled sessions</li>
                <li>Treat Trainers with respect and professionalism</li>
                <li>Follow the cancellation policy outlined below</li>
                <li>Leave honest and fair reviews based on your actual experience</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">5. For Trainers</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                As a Trainer using our Platform, you agree to:
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>Provide accurate information about your qualifications and experience</li>
                <li>Maintain appropriate certifications and insurance</li>
                <li>Honor all confirmed bookings</li>
                <li>Provide professional, safe, and quality training sessions</li>
                <li>Respond to booking requests in a timely manner</li>
                <li>Comply with all applicable laws and regulations</li>
                <li>Pay platform fees as specified in your subscription plan</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">6. Payments and Fees</h2>
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-medium mb-2">For Players:</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    Payment is processed through Stripe at the time of booking. The full lesson price is charged to your payment method. Refunds are handled according to our cancellation policy.
                  </p>
                </div>
                <div>
                  <h3 className="text-lg font-medium mb-2">For Trainers:</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    PadelTrainer.ai charges a platform fee (percentage varies by subscription plan) on each completed booking. The remaining amount is transferred to your connected Stripe account. Subscription fees are billed according to your chosen plan.
                  </p>
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">7. Cancellation Policy</h2>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li><strong>More than 24 hours before:</strong> Full refund</li>
                <li><strong>12-24 hours before:</strong> 50% refund</li>
                <li><strong>Less than 12 hours before:</strong> No refund</li>
                <li><strong>Trainer cancellations:</strong> Players receive a full refund for any trainer-initiated cancellation</li>
              </ul>
              <p className="text-muted-foreground leading-relaxed mt-4">
                Repeated cancellations by either party may result in account restrictions or termination.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">8. Intellectual Property</h2>
              <p className="text-muted-foreground leading-relaxed">
                The Platform and its original content, features, and functionality are owned by PadelTrainer.ai and are protected by international copyright, trademark, patent, trade secret, and other intellectual property laws. You may not reproduce, distribute, modify, create derivative works of, publicly display, or exploit any content from our Platform without prior written permission.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">9. User Content</h2>
              <p className="text-muted-foreground leading-relaxed">
                You retain ownership of any content you submit to the Platform (reviews, profile information, etc.). By submitting content, you grant us a worldwide, non-exclusive, royalty-free license to use, reproduce, modify, and display such content in connection with operating the Platform. You are solely responsible for the content you submit and must ensure it does not violate any third-party rights or applicable laws.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">10. Prohibited Activities</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                You agree not to:
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li>Use the Platform for any illegal purpose</li>
                <li>Harass, abuse, or harm other users</li>
                <li>Provide false or misleading information</li>
                <li>Attempt to circumvent the Platform to avoid fees</li>
                <li>Scrape or collect user data without consent</li>
                <li>Upload malicious code or attempt to compromise Platform security</li>
                <li>Impersonate another person or entity</li>
                <li>Spam or send unsolicited communications</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">11. Disclaimer of Warranties</h2>
              <p className="text-muted-foreground leading-relaxed">
                The Platform is provided on an "AS IS" and "AS AVAILABLE" basis. We make no warranties, expressed or implied, regarding the Platform's operation or the information, content, or materials included. We do not guarantee the accuracy, reliability, or completeness of any information on the Platform. We are not responsible for the quality, safety, or legality of training sessions arranged through the Platform.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">12. Limitation of Liability</h2>
              <p className="text-muted-foreground leading-relaxed">
                To the maximum extent permitted by law, PadelTrainer.ai shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits, data, or other intangible losses, resulting from your use or inability to use the Platform, any conduct of third parties on the Platform, or unauthorized access to your account.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">13. Indemnification</h2>
              <p className="text-muted-foreground leading-relaxed">
                You agree to indemnify and hold harmless PadelTrainer.ai, its officers, directors, employees, and agents from any claims, damages, losses, liabilities, and expenses (including legal fees) arising from your use of the Platform, violation of these Terms, or infringement of any third-party rights.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">14. Dispute Resolution</h2>
              <p className="text-muted-foreground leading-relaxed mb-4">
                In case of disputes:
              </p>
              <ul className="list-disc pl-6 text-muted-foreground space-y-2">
                <li><strong>Between Users:</strong> We encourage Players and Trainers to resolve disputes directly. We may assist in mediation but are not obligated to do so.</li>
                <li><strong>With PadelTrainer.ai:</strong> Any disputes with the Platform shall be resolved through binding arbitration in accordance with Dutch law, or through the courts of the Netherlands.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">15. Termination</h2>
              <p className="text-muted-foreground leading-relaxed">
                We may terminate or suspend your account immediately, without prior notice, for any reason, including breach of these Terms. Upon termination, your right to use the Platform will immediately cease. All provisions of the Terms which should survive termination shall survive, including ownership provisions, warranty disclaimers, and limitations of liability.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">16. Changes to Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                We reserve the right to modify or replace these Terms at any time. If changes are material, we will provide at least 30 days' notice before the new terms take effect. What constitutes a material change will be determined at our sole discretion. Continued use of the Platform after changes constitutes acceptance of the new Terms.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">17. Governing Law</h2>
              <p className="text-muted-foreground leading-relaxed">
                These Terms shall be governed by and construed in accordance with the laws of the Netherlands, without regard to its conflict of law provisions. Our failure to enforce any right or provision of these Terms will not be considered a waiver of those rights.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold mb-4">18. Contact Us</h2>
              <p className="text-muted-foreground leading-relaxed">
                If you have any questions about these Terms, please contact us at:
              </p>
              <div className="bg-accent rounded-lg p-6 mt-4">
                <p className="text-foreground font-medium">PadelTrainer.ai</p>
                <p className="text-muted-foreground">Email: legal@padeltrainer.ai</p>
                <p className="text-muted-foreground">General inquiries: hello@padeltrainer.ai</p>
              </div>
            </section>
          </div>
        </motion.div>
      </div>
    </MarketingLayout>
  );
}
