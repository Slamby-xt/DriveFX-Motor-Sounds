/* DriveFX settings you are expected to edit. Loaded before paywall.js. */
window.DFX_CONFIG = {
  // STRIPE: paste the three Payment Link URLs here (https://buy.stripe.com/...), one per plan.
  // The customer's device ID is appended automatically as ?client_reference_id=DFX-XXXX-XXXX, which is how a payment is
  // matched to the browser. While a link is empty, that plan's button says "PAYMENTS OPEN SOON" and no QR code is shown.
  payLinks: {
    monthly: '',   // $2.99 / month
    yearly: '',    // $29.99 / year
    lifetime: '',  // $49.99 one time
  },
  // Shown in the window for customers who have trouble paying. Leave '' to hide the line.
  support: '',     // e.g. 'help@drivefx.pro'
};
