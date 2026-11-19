#!/bin/sh
# A stand-in for the Linux dictation helper (apps/canopy-dictate-linux) for UI
# automation: it speaks the helper protocol without a speech model. It
# reports what it was given, so a spec can check VoiceService's arguments.
case " $* " in
  *" --probe "*)
    echo '{"supported":true}'
    exit 0
    ;;
  *" --request-authorization "*)
    echo '{"speechRecognition":"authorized"}'
    exit 0
    ;;
esac
bytes=$(wc -c | tr -d ' ')
echo '{"type":"interim","text":"Hello from"}'
echo "{\"type\":\"final\",\"text\":\"Hello from the fake helper: ${bytes} bytes, args [$*].\"}"
echo '{"type":"stopped"}'
