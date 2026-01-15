import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, CreditCard, Building2, Shield, Lock, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Checkout() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, loading } = useAuth();
  const { toast } = useToast();
  
  const [paymentMethod, setPaymentMethod] = useState('ideal');
  const [processing, setProcessing] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  
  // Get booking details from URL params (would come from booking flow)
  const lessonTitle = searchParams.get('lesson') || 'Padel Training Session';
  const trainerName = searchParams.get('trainer') || 'Coach';
  const date = searchParams.get('date') || 'Upcoming';
  const price = parseFloat(searchParams.get('price') || '50');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const handlePayment = async () => {
    setProcessing(true);
    
    // Simulate payment processing
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // In real implementation, this would call Stripe
    toast({
      title: 'Payment UI Ready',
      description: 'Stripe integration required to process actual payments',
    });
    
    setPaymentComplete(true);
    setProcessing(false);
  };

  if (paymentComplete) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 via-background to-green-100/30 dark:from-green-950/20 dark:via-background dark:to-green-900/10">
        <div className="container mx-auto px-4 py-16">
          <div className="max-w-md mx-auto text-center">
            <div className="w-20 h-20 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="h-10 w-10 text-green-600" />
            </div>
            <h1 className="text-3xl font-bold mb-4">Payment Successful!</h1>
            <p className="text-muted-foreground mb-8">
              Your booking has been confirmed. You'll receive a confirmation email shortly.
            </p>
            <Card className="text-left mb-8">
              <CardContent className="pt-6 space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Lesson</span>
                  <span className="font-medium">{lessonTitle}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Trainer</span>
                  <span className="font-medium">{trainerName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Date</span>
                  <span className="font-medium">{date}</span>
                </div>
                <Separator />
                <div className="flex justify-between text-lg font-bold">
                  <span>Total Paid</span>
                  <span className="text-green-600">€{price.toFixed(2)}</span>
                </div>
              </CardContent>
            </Card>
            <div className="space-y-3">
              <Button onClick={() => navigate('/bookings')} className="w-full">
                View My Bookings
              </Button>
              <Button variant="outline" onClick={() => navigate('/trainers')} className="w-full">
                Book Another Lesson
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-2xl">🎾</span>
              <span className="font-bold text-xl">Checkout</span>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto grid lg:grid-cols-5 gap-8">
          {/* Payment Form */}
          <div className="lg:col-span-3 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  Payment Method
                </CardTitle>
                <CardDescription>
                  Choose your preferred payment method
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RadioGroup value={paymentMethod} onValueChange={setPaymentMethod} className="space-y-4">
                  {/* iDEAL - Primary for Netherlands */}
                  <div className={`flex items-center space-x-4 p-4 rounded-lg border-2 transition-colors cursor-pointer ${paymentMethod === 'ideal' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}>
                    <RadioGroupItem value="ideal" id="ideal" />
                    <Label htmlFor="ideal" className="flex items-center gap-3 cursor-pointer flex-1">
                      <div className="w-12 h-8 bg-gradient-to-r from-pink-500 to-purple-600 rounded flex items-center justify-center text-white font-bold text-xs">
                        iDEAL
                      </div>
                      <div>
                        <p className="font-medium">iDEAL</p>
                        <p className="text-sm text-muted-foreground">Pay with your Dutch bank</p>
                      </div>
                    </Label>
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">Popular</span>
                  </div>

                  {/* Credit/Debit Card */}
                  <div className={`flex items-center space-x-4 p-4 rounded-lg border-2 transition-colors cursor-pointer ${paymentMethod === 'card' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}>
                    <RadioGroupItem value="card" id="card" />
                    <Label htmlFor="card" className="flex items-center gap-3 cursor-pointer flex-1">
                      <div className="w-12 h-8 bg-gradient-to-r from-blue-600 to-blue-800 rounded flex items-center justify-center">
                        <CreditCard className="h-4 w-4 text-white" />
                      </div>
                      <div>
                        <p className="font-medium">Credit / Debit Card</p>
                        <p className="text-sm text-muted-foreground">Visa, Mastercard, Amex</p>
                      </div>
                    </Label>
                  </div>

                  {/* Bancontact */}
                  <div className={`flex items-center space-x-4 p-4 rounded-lg border-2 transition-colors cursor-pointer ${paymentMethod === 'bancontact' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'}`}>
                    <RadioGroupItem value="bancontact" id="bancontact" />
                    <Label htmlFor="bancontact" className="flex items-center gap-3 cursor-pointer flex-1">
                      <div className="w-12 h-8 bg-gradient-to-r from-yellow-400 to-blue-500 rounded flex items-center justify-center text-white font-bold text-xs">
                        BC
                      </div>
                      <div>
                        <p className="font-medium">Bancontact</p>
                        <p className="text-sm text-muted-foreground">Pay with your Belgian bank</p>
                      </div>
                    </Label>
                  </div>
                </RadioGroup>
              </CardContent>
            </Card>

            {/* Bank Selection for iDEAL */}
            {paymentMethod === 'ideal' && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Building2 className="h-5 w-5" />
                    Select Your Bank
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {['ABN AMRO', 'ING', 'Rabobank', 'SNS Bank', 'ASN Bank', 'Triodos Bank', 'Bunq', 'Knab'].map((bank) => (
                      <Button key={bank} variant="outline" className="h-12 text-sm hover:border-primary hover:bg-primary/5">
                        {bank}
                      </Button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Security Notice */}
            <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
              <Shield className="h-5 w-5 text-green-600" />
              <p className="text-sm text-muted-foreground">
                Your payment is secured with 256-bit SSL encryption. We never store your card details.
              </p>
            </div>
          </div>

          {/* Order Summary */}
          <div className="lg:col-span-2">
            <Card className="sticky top-24">
              <CardHeader>
                <CardTitle>Order Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <h3 className="font-semibold mb-2">{lessonTitle}</h3>
                  <p className="text-sm text-muted-foreground">with {trainerName}</p>
                  <p className="text-sm text-muted-foreground">{date}</p>
                </div>
                
                <Separator />
                
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Lesson Price</span>
                    <span>€{price.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Service Fee</span>
                    <span>€0.00</span>
                  </div>
                </div>
                
                <Separator />
                
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span>€{price.toFixed(2)}</span>
                </div>
              </CardContent>
              <CardFooter className="flex-col gap-4">
                <Button 
                  className="w-full h-12 text-base" 
                  size="lg"
                  onClick={handlePayment}
                  disabled={processing}
                >
                  {processing ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Processing...
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4 mr-2" />
                      Pay €{price.toFixed(2)}
                    </>
                  )}
                </Button>
                <p className="text-xs text-center text-muted-foreground">
                  By completing this payment, you agree to our Terms of Service
                </p>
              </CardFooter>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}