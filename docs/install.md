# Installing thel

thel is beta. It runs on Linux (x86_64) and macOS (Apple silicon). Windows is a
goal but untested.

## macOS

The macOS build is not signed with an Apple Developer ID, so however you
install it, macOS quarantines it and refuses to launch it, usually with "thel
is damaged and can't be opened" or "the developer cannot be verified". Clear
the quarantine flag once, after installing:

```sh
xattr -dr com.apple.quarantine /Applications/thel.app
```

Homebrew used to take a `--no-quarantine` flag for this. It was removed in
Homebrew 5.1, so the step above is manual whichever way you install.

### Homebrew

```sh
brew install --cask joaquimrocha/tap/thel
```

Then run the `xattr` command above.

### Direct download

1. Download `thel_<version>_aarch64.dmg` from the
   [latest release](https://github.com/joaquimrocha/thel/releases/latest).
2. Open it and drag **thel** into Applications.
3. Run the `xattr` command above.

## Linux

### Homebrew

```sh
brew install --cask joaquimrocha/tap/thel
```

### Direct download

Download `thel-<version>-linux-x86_64.tar.xz` from the
[latest release](https://github.com/joaquimrocha/thel/releases/latest) and
unpack it. It contains a single self-contained `thel` binary, so put it
anywhere on your `PATH`:

```sh
tar -xf thel-*-linux-x86_64.tar.xz
install -Dm755 thel ~/.local/bin/thel
```

For a desktop entry, copy
[`packaging/dev.thel.Thel.desktop`](../packaging/dev.thel.Thel.desktop) into
`~/.local/share/applications/`.

## Windows

There is no Windows build yet. Releases carry a macOS `.dmg` and a Linux
tarball only, and nothing on Windows is tested, so parts that lean on Unix
sockets and PTYs, such as the session daemon, are not expected to work as they
stand.

Windows support is a goal. Tauri itself already runs there, so the work sits in
thel's own terminal and daemon layers rather than in the shell around them.
Until it lands, the closest thing is running the Linux build under WSL2 with
GUI support, which is not tested either.

## From source

See [Prerequisites and Develop](../README.md#prerequisites) in the README.
`pnpm tauri build` produces a bundle for the platform you are on.
