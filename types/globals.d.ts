// Global browser augmentations for the Fleets Dispatcher

export {}

declare global {
  interface Window {
    // intentionally empty — file objects are managed via FileContext (useFileStore)
    // See components/FileContext.tsx
  }
}
