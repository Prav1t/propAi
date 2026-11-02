import webpush from "web-push";
import { TEST_ENV } from "./test-env";

// VAPID keys are generated per test process rather than kept in the repository
const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, TEST_ENV, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey });
