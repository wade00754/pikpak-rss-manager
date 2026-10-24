package container

import (
	"context"
	"debug/elf"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Inspect the copied executable without running it. Emulation can otherwise hide
// a binary whose architecture does not match the image's platform declaration.
func checkContainerArchitecture(ctx context.Context, docker dockerRunner, container, directory, expectedPlatform string) error {
	image, err := docker(ctx, "inspect", "--format", "{{.Image}}", container)
	if err != nil {
		return err
	}
	platform, err := docker(ctx, "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image)
	if err != nil {
		return err
	}
	if expectedPlatform != "" && platform != expectedPlatform {
		return fmt.Errorf("expected image platform %s, got %s", expectedPlatform, platform)
	}
	path := filepath.Join(directory, "container-executable")
	if _, err := docker(ctx, "cp", container+":/app/pikpak-rss-manager", path); err != nil {
		return err
	}
	return checkExecutableArchitecture(path, platform)
}

func checkExecutableArchitecture(path, platform string) error {
	want, supported := map[string]elf.Machine{
		"linux/amd64": elf.EM_X86_64,
		"linux/arm64": elf.EM_AARCH64,
	}[platform]
	if !supported {
		return fmt.Errorf("unsupported image platform %q", platform)
	}
	executable, err := elf.Open(path)
	if err != nil {
		return fmt.Errorf("read container executable: %w", err)
	}
	defer executable.Close()
	if executable.Class != elf.ELFCLASS64 || executable.Data != elf.ELFDATA2LSB || executable.Machine != want {
		return fmt.Errorf("image platform %s contains incompatible executable: class=%s data=%s machine=%s", platform, executable.Class, executable.Data, executable.Machine)
	}
	return nil
}

func elfFixture(machine elf.Machine) []byte {
	header := make([]byte, 64)
	copy(header, []byte{0x7f, 'E', 'L', 'F', byte(elf.ELFCLASS64), byte(elf.ELFDATA2LSB), byte(elf.EV_CURRENT)})
	binary.LittleEndian.PutUint16(header[16:], uint16(elf.ET_EXEC))
	binary.LittleEndian.PutUint16(header[18:], uint16(machine))
	binary.LittleEndian.PutUint32(header[20:], uint32(elf.EV_CURRENT))
	binary.LittleEndian.PutUint16(header[52:], uint16(len(header)))
	return header
}

func TestExecutableArchitecture(t *testing.T) {
	for _, test := range []struct {
		name, platform string
		data           []byte
		valid          bool
	}{
		{"amd64", "linux/amd64", elfFixture(elf.EM_X86_64), true},
		{"arm64", "linux/arm64", elfFixture(elf.EM_AARCH64), true},
		{"amd64 mislabeled arm64", "linux/arm64", elfFixture(elf.EM_X86_64), false},
		{"arm64 mislabeled amd64", "linux/amd64", elfFixture(elf.EM_AARCH64), false},
		{"unsupported architecture", "linux/386", elfFixture(elf.EM_386), false},
		{"invalid executable", "linux/arm64", []byte("not an ELF executable"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "executable")
			if err := os.WriteFile(path, test.data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := checkExecutableArchitecture(path, test.platform); (err == nil) != test.valid {
				t.Fatalf("unexpected executable validation result: %v", err)
			}
		})
	}
}
