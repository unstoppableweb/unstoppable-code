// Moved to desktop-shared so Electron main shares an automation the same way
// (CAN-6003); this module keeps its import path.
export {
  sharedAutomationActivity,
  storedAutomationActivity,
} from '@canopy/desktop-shared/lib/stored-automation-activity';
