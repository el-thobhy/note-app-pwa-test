USE [NoteDB]
GO

-- 1. Tambah kolom IsPublic ke tabel Notes jika belum ada
IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'Notes' AND COLUMN_NAME = 'IsPublic'
)
BEGIN
    ALTER TABLE Notes ADD IsPublic BIT NOT NULL DEFAULT 0;
    PRINT 'Kolom IsPublic berhasil ditambahkan.';
END
GO

-- 2. Update stored procedure
ALTER PROCEDURE [dbo].[uspNote]
    @Id                  INT              = NULL,
    @NoteId              INT              = NULL,
    @action              VARCHAR(100)     = NULL,
    @Title               NVARCHAR(255)    = NULL,
    @UserId              NVARCHAR(450)    = NULL,
    @IsPublic            BIT              = 0,
    @Created_by          NVARCHAR(255)    = NULL,
    @Modified_by         NVARCHAR(255)    = NULL,
    @Deleted_by          NVARCHAR(255)    = NULL,
    @LocationOfProject   NVARCHAR(500)    = NULL,
    @ClientName          NVARCHAR(100)    = NULL
AS
BEGIN
    SET NOCOUNT ON;

    -- INSERT
    IF @action = 'insert'
    BEGIN
        INSERT INTO Notes (Title, UserId, IsPublic, Created_by, Created_on, Is_delete, Client_Name, Location_of_Project)
        VALUES (@Title, @UserId, @IsPublic, @Created_by, GETDATE(), 0, @ClientName, @LocationOfProject);
        SELECT SCOPE_IDENTITY() AS NoteId;
    END

    -- GET ALL (admin)
    IF @action = 'get_all'
    BEGIN
        SELECT * FROM Notes WHERE Is_delete = 0;
    END

    -- GET ALL BY USER ID
    IF @action = 'get_all_by_user_id'
    BEGIN
        SELECT * FROM Notes WHERE Is_delete = 0 AND UserId = @UserId;
    END

    -- GET ALL PUBLIC (untuk collaboration rooms)
    IF @action = 'get_all_public'
    BEGIN
        SELECT * FROM Notes WHERE Is_delete = 0 AND IsPublic = 1;
    END

    -- GET ENTRIES BY NOTE ID
    IF @action = 'get_entries_by_note_id'
    BEGIN
        SELECT
            [Id],
            '' [Content],
            [Date],
            [UserId],
            [NoteId],
            [Created_by],
            [Created_on],
            [Modified_by],
            [Modified_on],
            [Deleted_by],
            [Deleted_on],
            [Is_delete],
            [Title_Note],
            [WH_start],
            [WH_end],
            [OT_start],
            [OT_end],
            [Total_WH],
            [Total_OT],
            [Status_absen]
        FROM DailyEntries
        WHERE NoteId = @NoteId AND Is_delete = 0
        ORDER BY Date DESC;
    END

    -- GET BY ID
    IF @action = 'get_by_id'
    BEGIN
        SELECT * FROM Notes WHERE Id = @Id AND Is_delete = 0;
    END

    -- UPDATE NOTE
    IF @action = 'update_note'
    BEGIN
        UPDATE Notes
        SET Title       = @Title,
            IsPublic    = @IsPublic,
            Modified_by = @Modified_by,
            Modified_on = GETDATE()
        WHERE Id = @Id AND Is_delete = 0;
    END

    -- DELETE (soft delete)
    IF @action = 'delete'
    BEGIN
        UPDATE Notes
        SET Is_delete  = 1,
            Deleted_by = @Deleted_by,
            Deleted_on = GETDATE()
        WHERE Id = @Id;
    END
END
GO

PRINT 'uspNote berhasil diupdate.';
