# The disk image macos/build.sh makes: the app beside a link to Applications, on a
# background that says to drag one onto the other, and where the app goes after.
#
# Read by dmgbuild, which writes Finder's layout file itself. That is the reason
# for using it: the usual way, scripting Finder to arrange a mounted image, needs a
# permission prompt on the Mac doing the build and is flaky on a CI runner.
#
# The positions match the ones macos/Artwork/main.swift draws the arrow between.

import os.path

application = defines["app"]  # noqa: F821 -- dmgbuild provides `defines`
name = os.path.basename(application)

format = "UDZO"
filesystem = "HFS+"
files = [application]
symlinks = {"Applications": "/Applications"}
icon = defines.get("icon")  # noqa: F821
background = defines["background"]  # noqa: F821

window_rect = ((200, 120), (660, 400))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
include_icon_view_settings = True
arrange_by = None
icon_size = 128
text_size = 13
icon_locations = {
    name: (165, 180),
    "Applications": (495, 180),
}
