// Server components import the button from here, not the components barrel,
// which would pull client-only modules into the server graph.
export { ControlButton } from './primitives/Button';
