package store

import (
	"context"
	"database/sql"
	"errors"
)

type AppSettings struct {
	PublicURL         string `json:"public_url"`
	AllowPrivateFeeds bool   `json:"allow_private_feeds"`
}

// The verifier is never part of an API response. No password or reversible
// representation of a password is accepted by the persistence layer.
func (s *Store) Administrator(ctx context.Context) (string, AppSettings, error) {
	var hash string
	var settings AppSettings
	err := s.db.QueryRowContext(ctx, "SELECT password_hash,public_url,allow_private_feeds FROM administrator WHERE id=1").Scan(&hash, &settings.PublicURL, &settings.AllowPrivateFeeds)
	if errors.Is(err, sql.ErrNoRows) {
		return "", settings, nil
	}
	if err == nil && hash == "" {
		return "", settings, errors.New("密碼驗證值損毀")
	}
	return hash, settings, err
}

// A singleton primary key makes first setup atomic across concurrent requests
// and processes. A completed setup can never be overwritten by this method.
func (s *Store) InitializeAdministrator(ctx context.Context, hash string, settings AppSettings) (bool, error) {
	if hash == "" {
		return false, errors.New("密碼驗證值不可為空")
	}
	r, err := s.db.ExecContext(ctx, "INSERT INTO administrator(id,password_hash,public_url,allow_private_feeds) VALUES(1,?,?,?) ON CONFLICT(id) DO NOTHING", hash, settings.PublicURL, settings.AllowPrivateFeeds)
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}

func (s *Store) SaveAppSettings(ctx context.Context, settings AppSettings) error {
	_, err := s.db.ExecContext(ctx, "UPDATE administrator SET public_url=?,allow_private_feeds=? WHERE id=1", settings.PublicURL, settings.AllowPrivateFeeds)
	return err
}

// Replace only the verifier that was authenticated; never overwrite another
// password change or alter the administrator's application settings.
func (s *Store) ChangeAdministratorPassword(ctx context.Context, previous, hash string) error {
	if hash == "" {
		return errors.New("密碼驗證值不可為空")
	}
	r, err := s.db.ExecContext(ctx, "UPDATE administrator SET password_hash=? WHERE id=1 AND password_hash=?", hash, previous)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("administrator verifier changed or missing")
	}
	return nil
}
