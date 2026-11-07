# frozen_string_literal: true

# Entry point: `ruby --disable-gems main.rb manifest | analyze --root <path> …` (D-061).
#
# Run with --disable-gems: the analyzer reads the project's sources as text and needs only the standard library (Prism,
# JSON, Digest), not the gems of the user's environment, and starts faster without them.
$LOAD_PATH.unshift(File.join(__dir__, "lib"))
require "nomos_ruby/cli"

exit(NomosRuby.main(ARGV))
